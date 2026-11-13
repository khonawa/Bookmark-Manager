mod backups;
mod connector;
pub use connector::run_native_host;
mod library_sql;
mod metadata;
use library_sql::{apply_library_patch, query_bookmark_ids, query_bookmarks};
use metadata::fetch_metadata;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

type CommandResult<T> = Result<T, String>;

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    bookmarks: Vec<Bookmark>,
    collections: Vec<Collection>,
    #[serde(default)]
    trash: Vec<TrashedBookmark>,
    #[serde(default)]
    smart_collections: Vec<SmartCollection>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashedBookmark {
    #[serde(flatten)]
    bookmark: Bookmark,
    deleted_at: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    id: String,
    title: String,
    url: String,
    description: String,
    tags: Vec<String>,
    collection_ids: Vec<String>,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    id: String,
    name: String,
    parent_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmartCollection {
    id: String,
    name: String,
    rules: SmartRules,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmartRules {
    text: String,
    tags: Vec<String>,
    domain: String,
    untagged: bool,
    inbox: bool,
}

struct Database(Mutex<Connection>);

fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         CREATE TABLE IF NOT EXISTS collections (
             id TEXT PRIMARY KEY NOT NULL,
             name TEXT NOT NULL,
             parent_id TEXT,
             position INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS bookmarks (
             id TEXT PRIMARY KEY NOT NULL,
             title TEXT NOT NULL,
             url TEXT NOT NULL,
             description TEXT NOT NULL,
             tags_json TEXT NOT NULL,
             collection_ids_json TEXT NOT NULL,
             created_at TEXT NOT NULL,
             position INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS smart_collections (
             id TEXT PRIMARY KEY NOT NULL,
             name TEXT NOT NULL,
             rules_json TEXT NOT NULL,
             position INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS trash (
             id TEXT PRIMARY KEY NOT NULL,
             payload_json TEXT NOT NULL,
             position INTEGER NOT NULL
         );",
    )?;
    library_sql::install(connection)?;
    connector::install(connection)
}

fn read_library(connection: &mut Connection) -> CommandResult<Library> {
    // A read transaction keeps all lists on the same SQLite snapshot.
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let collections = {
        let mut statement = transaction
            .prepare("SELECT id, name, parent_id FROM collections ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    let smart_collections = {
        let mut statement = transaction
            .prepare("SELECT id,name,rules_json FROM smart_collections ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            let (id, name, rules) = row.map_err(|e| e.to_string())?;
            result.push(SmartCollection {
                id,
                name,
                rules: serde_json::from_str(&rules).map_err(|e| e.to_string())?,
            });
        }
        result
    };
    let bookmarks = {
        let mut statement = transaction
            .prepare(
                "SELECT id, title, url, description, tags_json, collection_ids_json, created_at
                 FROM bookmarks ORDER BY position",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let tags: String = row.get(4)?;
                let collection_ids: String = row.get(5)?;
                Ok((
                    Bookmark {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        url: row.get(2)?,
                        description: row.get(3)?,
                        tags: Vec::new(),
                        collection_ids: Vec::new(),
                        created_at: row.get(6)?,
                    },
                    tags,
                    collection_ids,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut bookmarks = Vec::new();
        for row in rows {
            let (mut bookmark, tags, collection_ids) = row.map_err(|e| e.to_string())?;
            bookmark.tags = serde_json::from_str(&tags).map_err(|e| e.to_string())?;
            bookmark.collection_ids =
                serde_json::from_str(&collection_ids).map_err(|e| e.to_string())?;
            bookmarks.push(bookmark);
        }
        bookmarks
    };
    let trash = {
        let mut statement = transaction
            .prepare("SELECT payload_json FROM trash ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut trash = Vec::new();
        for row in rows {
            let payload = row.map_err(|e| e.to_string())?;
            trash.push(serde_json::from_str(&payload).map_err(|e| e.to_string())?);
        }
        trash
    };
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(Library {
        bookmarks,
        collections,
        trash,
        smart_collections,
    })
}

fn write_library(connection: &mut Connection, library: &Library) -> CommandResult<()> {
    library_sql::validate_smart_collections(&library.smart_collections, &[])?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute_batch("DELETE FROM bookmarks; DELETE FROM collections; DELETE FROM trash; DELETE FROM smart_collections;")
        .map_err(|e| e.to_string())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO collections (id, name, parent_id, position) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| e.to_string())?;
        for (position, collection) in library.collections.iter().enumerate() {
            statement
                .execute(params![
                    collection.id,
                    collection.name,
                    collection.parent_id,
                    position as i64
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO smart_collections(id,name,rules_json,position) VALUES(?1,?2,?3,?4)",
            )
            .map_err(|e| e.to_string())?;
        for (position, collection) in library.smart_collections.iter().enumerate() {
            statement
                .execute(params![
                    collection.id,
                    collection.name,
                    serde_json::to_string(&collection.rules).map_err(|e| e.to_string())?,
                    position as i64
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO bookmarks
                 (id, title, url, description, tags_json, collection_ids_json, created_at, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;
        for (position, bookmark) in library.bookmarks.iter().enumerate() {
            let tags = serde_json::to_string(&bookmark.tags).map_err(|e| e.to_string())?;
            let collection_ids =
                serde_json::to_string(&bookmark.collection_ids).map_err(|e| e.to_string())?;
            statement
                .execute(params![
                    bookmark.id,
                    bookmark.title,
                    bookmark.url,
                    bookmark.description,
                    tags,
                    collection_ids,
                    bookmark.created_at,
                    position as i64
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction
            .prepare("INSERT INTO trash (id, payload_json, position) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (position, bookmark) in library.trash.iter().enumerate() {
            let payload = serde_json::to_string(bookmark).map_err(|e| e.to_string())?;
            statement
                .execute(params![bookmark.bookmark.id, payload, position as i64])
                .map_err(|e| e.to_string())?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn load_library(database: State<'_, Database>) -> CommandResult<Library> {
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "Database lock unavailable".to_string())?;
    read_library(&mut connection)
}

#[tauri::command]
fn save_library(database: State<'_, Database>, library: Library) -> CommandResult<()> {
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "Database lock unavailable".to_string())?;
    write_library(&mut connection, &library)
}

fn validated_url(url: &str) -> CommandResult<tauri::Url> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid bookmark URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Only HTTP and HTTPS bookmark URLs are supported".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
fn open_bookmark(app: tauri::AppHandle, url: String) -> CommandResult<()> {
    let parsed = validated_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let connection = Connection::open(directory.join("library.sqlite3"))?;
            initialize(&connection)?;
            app.manage(Database(Mutex::new(connection)));
            backups::start(app.handle(), &directory)?;
            connector::start(app.handle(), directory)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            backups::backup_status,
            backups::configure_backups,
            backups::list_backups,
            backups::create_backup,
            backups::read_backup,
            connector::load_library_snapshot,
            connector::get_library_revision,
            connector::configure_extension,
            connector::disable_extension,
            connector::get_extension_icon,
            connector::get_extension_status,
            save_library,
            query_bookmarks,
            query_bookmark_ids,
            apply_library_patch,
            open_bookmark,
            fetch_metadata
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run Bookmark Desk");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        connection
    }

    pub(super) fn sample() -> Library {
        serde_json::from_value(serde_json::json!({
            "bookmarks": [{
                "id": "b1", "title": "Example", "url": "https://example.com",
                "description": "Unicode: café", "tags": ["work", "reading"],
                "collectionIds": ["child", "root"], "createdAt": "2026-11-13T00:00:00Z"
            }],
            "collections": [
                {"id": "root", "name": "Root", "parentId": null},
                {"id": "child", "name": "Child", "parentId": "root"}
            ],
            "trash": [
                {
                    "id": "deleted-b", "title": "Deleted café", "url": "https://example.com/b",
                    "description": "Keep all fields", "tags": ["old", "reading"],
                    "collectionIds": ["child", "missing"], "createdAt": "2026-11-12T00:00:00Z",
                    "deletedAt": "2026-11-13T01:02:03Z"
                },
                {
                    "id": "deleted-a", "title": "Second", "url": "https://example.com/a",
                    "description": "", "tags": [], "collectionIds": [],
                    "createdAt": "2026-11-11T00:00:00Z", "deletedAt": "2026-11-13T02:03:04Z"
                }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn old_json_defaults_to_empty_trash() {
        let mut payload = serde_json::to_value(sample()).unwrap();
        payload.as_object_mut().unwrap().remove("trash");
        let library: Library = serde_json::from_value(payload).unwrap();
        assert!(library.trash.is_empty());
        assert_eq!(library.bookmarks, sample().bookmarks);
        assert_eq!(library.collections, sample().collections);
    }

    #[test]
    fn old_database_migration_preserves_library() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE collections (
                 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
                 parent_id TEXT, position INTEGER NOT NULL
             );
             CREATE TABLE bookmarks (
                 id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
                 description TEXT NOT NULL, tags_json TEXT NOT NULL,
                 collection_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
                 position INTEGER NOT NULL
             );
             INSERT INTO collections VALUES ('root', 'Root', NULL, 0);
             INSERT INTO bookmarks VALUES (
                 'legacy', 'Legacy café', 'https://example.com', 'Preserved',
                 '[\"work\"]', '[\"root\"]', '2026-11-12T00:00:00Z', 0
             );",
            )
            .unwrap();
        initialize(&connection).unwrap();
        initialize(&connection).unwrap();
        let expected: Library = serde_json::from_value(serde_json::json!({
            "bookmarks": [{
                "id": "legacy", "title": "Legacy café", "url": "https://example.com",
                "description": "Preserved", "tags": ["work"], "collectionIds": ["root"],
                "createdAt": "2026-11-12T00:00:00Z"
            }],
            "collections": [{"id": "root", "name": "Root", "parentId": null}]
        }))
        .unwrap();
        assert_eq!(read_library(&mut connection).unwrap(), expected);
        write_library(&mut connection, &expected).unwrap();
        assert_eq!(read_library(&mut connection).unwrap(), expected);
    }

    #[test]
    fn trash_json_is_flattened() {
        let library = sample();
        let value = serde_json::to_value(&library.trash[0]).unwrap();
        assert_eq!(value["id"], "deleted-b");
        assert_eq!(
            value["collectionIds"],
            serde_json::json!(["child", "missing"])
        );
        assert_eq!(value["deletedAt"], "2026-11-13T01:02:03Z");
        assert!(value.get("bookmark").is_none());
        assert_eq!(
            serde_json::from_value::<TrashedBookmark>(value).unwrap(),
            library.trash[0]
        );
    }

    #[test]
    fn empty_initial_state() {
        assert_eq!(read_library(&mut database()).unwrap(), Library::default());
    }

    #[test]
    fn round_trip_replace_and_clear() {
        let mut connection = database();
        let mut library = sample();
        write_library(&mut connection, &library).unwrap();
        assert_eq!(read_library(&mut connection).unwrap(), library);
        library.bookmarks[0].title = "Updated".into();
        library.collections.reverse();
        library.trash.reverse();
        library.trash[0].deleted_at = "2026-11-14T00:00:00Z".into();
        write_library(&mut connection, &library).unwrap();
        assert_eq!(read_library(&mut connection).unwrap(), library);
        write_library(&mut connection, &Library::default()).unwrap();
        assert_eq!(read_library(&mut connection).unwrap(), Library::default());
    }

    #[test]
    fn failed_save_rolls_back() {
        let mut connection = database();
        let library = sample();
        write_library(&mut connection, &library).unwrap();
        let mut invalid = sample();
        invalid.bookmarks.push(sample().bookmarks.remove(0));
        assert!(write_library(&mut connection, &invalid).is_err());
        assert_eq!(read_library(&mut connection).unwrap(), library);
    }

    #[test]
    fn failed_trash_save_rolls_back_entire_library() {
        let mut connection = database();
        let library = sample();
        write_library(&mut connection, &library).unwrap();
        let mut invalid = sample();
        invalid.bookmarks[0].title = "Must roll back".into();
        invalid.collections.clear();
        invalid.trash[0].deleted_at = "Must roll back".into();
        invalid.trash.push(sample().trash.remove(0));
        assert!(write_library(&mut connection, &invalid).is_err());
        assert_eq!(read_library(&mut connection).unwrap(), library);
    }

    #[test]
    fn persists_across_connections() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("persistence-test-{}.sqlite3", std::process::id()));
        {
            let mut connection = Connection::open(&path).unwrap();
            initialize(&connection).unwrap();
            write_library(&mut connection, &sample()).unwrap();
        }
        {
            let mut connection = Connection::open(&path).unwrap();
            initialize(&connection).unwrap();
            assert_eq!(read_library(&mut connection).unwrap(), sample());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn url_validation() {
        for url in ["https://example.com/path?q=1", "http://localhost:5173"] {
            assert!(validated_url(url).is_ok());
        }
        for url in [
            "javascript:alert(1)",
            "file:///C:/secret",
            "mailto:a@example.com",
            "not a URL",
            "",
        ] {
            assert!(validated_url(url).is_err());
        }
    }
}
