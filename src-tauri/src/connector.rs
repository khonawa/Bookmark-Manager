use super::*;
use base64::Engine;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
use tauri::Emitter;

const MAX_FRAME: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
const DESCRIPTOR: &str = "native-connector.json";

pub(super) fn install(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS library_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO library_revision VALUES(1,0);
        CREATE TABLE IF NOT EXISTS extension_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), extension_id TEXT NOT NULL, secret TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS extension_icons (bookmark_id TEXT PRIMARY KEY, icon TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS extension_receipts (request_id TEXT PRIMARY KEY, normalized_url TEXT NOT NULL, response TEXT NOT NULL);")?;
    for table in ["bookmarks", "collections", "trash", "smart_collections"] {
        for action in ["INSERT", "UPDATE", "DELETE"] {
            c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS revision_{table}_{action} AFTER {action} ON {table} BEGIN UPDATE library_revision SET revision=revision+1 WHERE singleton=1; END;"))?;
        }
    }
    Ok(())
}

pub(super) fn revision(c: &Connection) -> CommandResult<String> {
    c.query_row(
        "SELECT CAST(revision AS TEXT) FROM library_revision WHERE singleton=1",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    library: Library,
    revision: String,
}

#[tauri::command]
pub fn load_library_snapshot(database: State<'_, Database>) -> CommandResult<LibrarySnapshot> {
    let mut c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    let library = read_library(&mut c)?;
    Ok(LibrarySnapshot {
        library,
        revision: revision(&c)?,
    })
}
#[tauri::command]
pub fn get_library_revision(database: State<'_, Database>) -> CommandResult<String> {
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    revision(&c)
}

fn extension_origin(id: &str) -> CommandResult<String> {
    if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
        return Err("Invalid Chrome extension ID".into());
    }
    Ok(format!("chrome-extension://{id}/"))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    port: u16,
    secret: String,
    origin: String,
}
pub struct Bridge {
    path: PathBuf,
    port: u16,
}

#[tauri::command]
pub fn configure_extension(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    bridge: State<'_, Bridge>,
    extension_id: String,
) -> CommandResult<Value> {
    let origin = extension_origin(&extension_id)?;
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    c.execute("INSERT INTO extension_config VALUES(1,?1,lower(hex(randomblob(32)))) ON CONFLICT(singleton) DO UPDATE SET extension_id=excluded.extension_id,secret=excluded.secret", [&extension_id]).map_err(|e|e.to_string())?;
    let secret: String = c
        .query_row(
            "SELECT secret FROM extension_config WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let descriptor = Descriptor {
        port: bridge.port,
        secret,
        origin: origin.clone(),
    };
    if let Err(e) = std::fs::write(
        &bridge.path,
        serde_json::to_vec(&descriptor).map_err(|e| e.to_string())?,
    ) {
        let _ = c.execute("DELETE FROM extension_config", []);
        return Err(e.to_string());
    }
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("bookmark-desk-connector.exe");
    let _ = app;
    Ok(
        json!({"extensionId":extension_id,"origin":origin,"descriptorPath":bridge.path,"connectorExe":exe,"hostName":"com.bookmarkdesk.connector", "setupCommands": setup_commands(&extension_id, &exe)}),
    )
}
#[tauri::command]
pub fn disable_extension(
    database: State<'_, Database>,
    bridge: State<'_, Bridge>,
) -> CommandResult<()> {
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    c.execute("DELETE FROM extension_config", [])
        .map_err(|e| e.to_string())?;
    match std::fs::remove_file(&bridge.path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn normalized_url(raw: &str) -> CommandResult<String> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) {
        return Err("Invalid URL".into());
    }
    let mut u = url::Url::parse(raw).map_err(|_| "Invalid URL")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("URL must be HTTP/S with a host and no credentials".into());
    }
    u.set_fragment(None);
    Ok(u.to_string())
}
fn text(s: &str, max: usize) -> CommandResult<()> {
    if s.chars().count() > max || s.chars().any(char::is_control) {
        Err("Text exceeds limit or contains control characters".into())
    } else {
        Ok(())
    }
}
fn icon(s: &str) -> CommandResult<()> {
    if s.is_empty() {
        return Ok(());
    }
    if !s.starts_with("data:") {
        return normalized_url(s).map(|_| ());
    }
    let (prefix, data) = s.split_once(',').ok_or("Invalid favicon")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid favicon base64")?;
    if bytes.len() > 128 * 1024 {
        return Err("Favicon exceeds 128 KiB".into());
    }
    let valid = match prefix {
        "data:image/png;base64" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "data:image/jpeg;base64" => bytes.starts_with(b"\xff\xd8\xff"),
        "data:image/gif;base64" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "data:image/webp;base64" => {
            bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
        }
        "data:image/x-icon;base64" | "data:image/vnd.microsoft.icon;base64" => {
            bytes.starts_with(b"\0\0\x01\0")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Invalid raster favicon".into())
    }
}
#[tauri::command]
pub fn get_extension_icon(
    database: State<'_, Database>,
    url: String,
) -> CommandResult<Option<String>> {
    let url = normalized_url(&url)?;
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    let mut q=c.prepare("SELECT b.url,i.icon FROM bookmarks b JOIN extension_icons i ON i.bookmark_id=b.id ORDER BY b.position").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (u, i) = row.map_err(|e| e.to_string())?;
        if normalized_url(&u).ok().as_ref() == Some(&url) {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    op: String,
    url: Option<String>,
    request_id: Option<String>,
    title: Option<String>,
    favicon: Option<String>,
    tags: Option<Vec<String>>,
    collection_ids: Option<Vec<String>>,
    created_at: Option<String>,
}

fn process(c: &mut Connection, request: Value) -> CommandResult<Value> {
    let r: Request = serde_json::from_value(request).map_err(|e| e.to_string())?;
    if r.op == "catalog" {
        let library = read_library(c)?;
        let mut tags: Vec<String> = library
            .bookmarks
            .iter()
            .flat_map(|b| b.tags.clone())
            .collect();
        tags.sort();
        tags.dedup();
        return Ok(json!({"ok":true,"collections":library.collections,"tags":tags}));
    }
    if r.op != "check" && r.op != "save" {
        return Err("Unknown operation".into());
    }
    let u = normalized_url(r.url.as_deref().ok_or("URL required")?)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let existing = {
        let mut q = tx
            .prepare("SELECT id,url FROM bookmarks ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut found = None;
        for row in rows {
            let (id, url) = row.map_err(|e| e.to_string())?;
            if normalized_url(&url).ok().as_ref() == Some(&u) {
                found = Some(id);
                break;
            }
        }
        found
    };
    if r.op == "check" {
        return Ok(json!({"ok":true,"saved":existing.is_some()}));
    }
    if let Some(id) = &r.request_id {
        text(id, 128)?;
        if id.is_empty() {
            return Err("Empty request ID".into());
        }
        let receipt: Option<(String, String)> = tx
            .query_row(
                "SELECT normalized_url,response FROM extension_receipts WHERE request_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((url, response)) = receipt {
            if url != u {
                return Err("Request ID reused for another URL".into());
            }
            return serde_json::from_str(&response).map_err(|e| e.to_string());
        }
    }
    let title = r.title.unwrap_or_else(|| u.clone());
    text(&title, 2048)?;
    let tags = r.tags.unwrap_or_default();
    if tags.len() > 32 {
        return Err("Too many tags".into());
    }
    for t in &tags {
        text(t, 100)?;
    }
    let collections = r.collection_ids.unwrap_or_default();
    if collections.len() > 1024 {
        return Err("Too many collections".into());
    }
    for id in &collections {
        text(id, 256)?;
        if id.is_empty() {
            return Err("Empty collection ID".into());
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("Unknown collection".into());
        }
    }
    let favicon = r.favicon.unwrap_or_default();
    icon(&favicon)?;
    let created = r.created_at.unwrap_or(
        tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?,
    );
    text(&created, 100)?;
    let valid_created: bool = tx
        .query_row("SELECT julianday(?1) IS NOT NULL", [&created], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !valid_created {
        return Err("Invalid creation timestamp".into());
    }
    let response = if let Some(id) = existing {
        json!({"ok":true,"status":"already-saved","id":id})
    } else {
        let id: String = tx
            .query_row("SELECT 'ext-' || lower(hex(randomblob(16)))", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO bookmarks VALUES(?1,?2,?3,'',?4,?5,?6,(SELECT coalesce(max(position),-1)+1 FROM bookmarks))",params![id,title,u,serde_json::to_string(&tags).unwrap(),serde_json::to_string(&collections).unwrap(),created]).map_err(|e|e.to_string())?;
        if !favicon.is_empty() {
            tx.execute(
                "INSERT OR REPLACE INTO extension_icons VALUES(?1,?2)",
                params![id, favicon],
            )
            .map_err(|e| e.to_string())?;
        }
        json!({"ok":true,"status":"saved","id":id})
    };
    if let Some(id) = r.request_id {
        tx.execute(
            "INSERT INTO extension_receipts VALUES(?1,?2,?3)",
            params![id, u, response.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response)
}

fn read_frame(reader: &mut impl Read) -> CommandResult<Option<Value>> {
    let mut header = [0; 4];
    match reader.read(&mut header[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => (),
        Err(e) => return Err(e.to_string()),
    }
    reader
        .read_exact(&mut header[1..])
        .map_err(|e| e.to_string())?;
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err("Invalid frame length".into());
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn write_frame(writer: &mut impl Write, v: &Value) -> CommandResult<()> {
    let body = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    if body.len() > MAX_FRAME {
        return Err("Response too large".into());
    }
    writer
        .write_all(&(body.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}
fn serve(app: &tauri::AppHandle, stream: &mut TcpStream) -> CommandResult<()> {
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    let envelope = read_frame(&mut DeadlineReader {
        stream,
        deadline: std::time::Instant::now() + TIMEOUT,
    })?
    .ok_or("Empty request")?;
    let database = app.state::<Database>();
    let mut c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    let response = authenticated_process(&mut c, envelope);
    drop(c);
    if let Ok(v) = &response {
        if v.get("status").and_then(Value::as_str) == Some("saved") {
            let _ = app.emit("extension-saved", ());
        }
    }
    write_frame(
        stream,
        &response.unwrap_or_else(|e| json!({"ok":false,"error":e})),
    )
}

pub(super) fn start(app: &tauri::AppHandle, directory: PathBuf) -> CommandResult<()> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let path = directory.join(DESCRIPTOR);
    // Pairing survives desktop restarts; every explicit pairing rotates the secret.
    {
        let database = app.state::<Database>();
        let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
        let paired: Option<(String, String)> = c
            .query_row(
                "SELECT extension_id,secret FROM extension_config WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((id, secret)) = paired {
            std::fs::write(
                &path,
                serde_json::to_vec(&Descriptor {
                    port,
                    secret,
                    origin: extension_origin(&id)?,
                })
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    app.manage(Bridge { path, port });
    let app = app.clone();
    std::thread::spawn(move || {
        let active = std::sync::Arc::new(AtomicUsize::new(0));
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                if active.fetch_add(1, Ordering::SeqCst) >= 8 {
                    active.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let app = app.clone();
                let active = active.clone();
                std::thread::spawn(move || {
                    if let Err(e) = serve(&app, &mut stream) {
                        let _ = write_frame(&mut stream, &json!({"ok":false,"error":e}));
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        }
    });
    Ok(())
}

fn descriptor_path() -> CommandResult<PathBuf> {
    let config: Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).map_err(|e| e.to_string())?;
    let identifier = config["identifier"].as_str().ok_or("Missing identifier")?;
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or("APPDATA missing")?;
    #[cfg(target_os = "macos")]
    let base = PathBuf::from(std::env::var_os("HOME").ok_or("HOME missing")?)
        .join("Library")
        .join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or(
            PathBuf::from(std::env::var_os("HOME").ok_or("HOME missing")?)
                .join(".local")
                .join("share"),
        );
    Ok(base.join(identifier).join(DESCRIPTOR))
}
fn host() -> CommandResult<()> {
    let origin = std::env::args()
        .nth(1)
        .ok_or("Chrome origin argument required")?;
    let bytes = std::fs::read(descriptor_path()?)
        .map_err(|_| "Start Bookmark Desk and pair the extension first")?;
    if bytes.len() > 4096 {
        return Err("Invalid descriptor".into());
    }
    let d: Descriptor = serde_json::from_slice(&bytes).map_err(|_| "Invalid descriptor")?;
    let id = d
        .origin
        .strip_prefix("chrome-extension://")
        .and_then(|s| s.strip_suffix('/'))
        .ok_or("Invalid origin")?;
    if extension_origin(id)? != origin
        || d.origin != origin
        || d.secret.len() != 64
        || !d.secret.bytes().all(|b| b.is_ascii_hexdigit())
        || d.port == 0
    {
        return Err("Extension origin is not paired".into());
    }
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    while let Some(request) = read_frame(&mut input)? {
        let result = (|| {
            let mut stream = TcpStream::connect_timeout(
                &SocketAddrV4::new(Ipv4Addr::LOCALHOST, d.port).into(),
                TIMEOUT,
            )
            .map_err(|_| "Bookmark Desk is not running")?;
            stream
                .set_read_timeout(Some(TIMEOUT))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(TIMEOUT))
                .map_err(|e| e.to_string())?;
            write_frame(
                &mut stream,
                &json!({"origin":origin,"secret":d.secret,"request":request}),
            )?;
            read_frame(&mut stream)?.ok_or("Desktop closed connection".into())
        })();
        write_frame(
            &mut output,
            &result.unwrap_or_else(|e: String| json!({"ok":false,"error":e})),
        )?;
    }
    Ok(())
}
pub fn run_native_host() {
    if let Err(error) = host() {
        let _ = write_frame(
            &mut std::io::stdout().lock(),
            &json!({"ok":false,"error":error}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        c
    }
    #[test]
    fn security_validation_and_framing() {
        for u in [
            "file:///secret",
            "https://user:pass@example.com",
            "https://example.com/\n",
            "http:///",
            "javascript:alert(1)",
        ] {
            assert!(normalized_url(u).is_err(), "{u}");
        }
        assert_eq!(
            normalized_url("https://example.com/a#frag").unwrap(),
            "https://example.com/a"
        );
        assert!(normalized_url(&format!("https://example.com/{}", "x".repeat(8192))).is_err());
        assert!(extension_origin(&"a".repeat(32)).is_ok());
        assert!(extension_origin(&"z".repeat(32)).is_err());
        assert!(extension_origin(&format!("{}/", "a".repeat(32))).is_err());
        assert!(text("a\n", 2048).is_err());
        assert!(icon("data:image/svg+xml;base64,PHN2Zz4=").is_err());
        assert!(icon("data:image/png;base64,AAAA").is_err());
        assert!(icon(&format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0; 128 * 1024 + 1])
        ))
        .is_err());
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({"ok":true})).unwrap();
        assert_eq!(
            read_frame(&mut bytes.as_slice()).unwrap(),
            Some(json!({"ok":true}))
        );
        assert!(read_frame(&mut ((MAX_FRAME as u32 + 1).to_le_bytes().as_slice())).is_err());
        assert!(read_frame(&mut [5, 0, 0, 0, b'{'].as_slice()).is_err());
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
    }
    #[test]
    fn transactional_idempotence_and_preservation() {
        let mut c = db();
        let initial = super::super::tests::sample();
        write_library(&mut c, &initial).unwrap();
        let before = revision(&c).unwrap();
        let request = json!({"op":"save","url":"https://new.example/a#one","requestId":"request1","tags":["new"],"collectionIds":["child"],"favicon":"https://new.example/icon.png"});
        let first = process(&mut c, request.clone()).unwrap();
        assert_eq!(first["status"], "saved");
        assert_eq!(process(&mut c, request).unwrap(), first);
        assert_ne!(revision(&c).unwrap(), before);
        let saved = read_library(&mut c).unwrap();
        assert_eq!(saved.bookmarks.len(), initial.bookmarks.len() + 1);
        assert_eq!(saved.trash, initial.trash);
        assert_eq!(saved.collections, initial.collections);
        assert_eq!(saved.bookmarks[0], initial.bookmarks[0]);
        assert_eq!(
            process(
                &mut c,
                json!({"op":"check","url":"https://new.example/a#two"})
            )
            .unwrap()["saved"],
            true
        );
        assert_eq!(
            process(
                &mut c,
                json!({"op":"save","url":"https://new.example/a#three"})
            )
            .unwrap()["status"],
            "already-saved"
        );
        assert!(process(
            &mut c,
            json!({"op":"save","url":"https://other.example","requestId":"request1"})
        )
        .is_err());
        let revision = revision(&c).unwrap();
        assert!(process(&mut c,json!({"op":"save","url":"https://bad.example","requestId":"bad","collectionIds":["missing"]})).is_err());
        assert_eq!(super::revision(&c).unwrap(), revision);
        let count: i64 = c
            .query_row(
                "SELECT count(*) FROM extension_receipts WHERE request_id='bad'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        process(&mut c, json!({"op":"save","url":"https://example.com/b"})).unwrap();
        assert_eq!(read_library(&mut c).unwrap().trash, initial.trash);
    }
    #[test]
    fn receipts_survive_reopening_and_triggers_preserve_legacy_writes() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("connector-test-{}.sqlite3", std::process::id()));
        let request = json!({"op":"save","url":"https://persist.example","requestId":"persistent"});
        let response = {
            let mut c = Connection::open(&path).unwrap();
            initialize(&c).unwrap();
            process(&mut c, request.clone()).unwrap()
        };
        {
            let mut c = Connection::open(&path).unwrap();
            initialize(&c).unwrap();
            assert_eq!(process(&mut c, request).unwrap(), response);
            assert_eq!(read_library(&mut c).unwrap().bookmarks.len(), 1);
        }
        std::fs::remove_file(path).unwrap();
    }
}

fn authenticated_process(c: &mut Connection, envelope: Value) -> CommandResult<Value> {
    let paired: Option<(String, String)> = c
        .query_row(
            "SELECT extension_id,secret FROM extension_config WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (id, secret) = paired.ok_or("Extension disabled")?;
    if envelope.get("secret").and_then(Value::as_str) != Some(secret.as_str())
        || envelope.get("origin").and_then(Value::as_str) != Some(extension_origin(&id)?.as_str())
    {
        return Err("Unauthorized connector".into());
    }
    process(
        c,
        envelope.get("request").cloned().ok_or("Missing request")?,
    )
}

#[tauri::command]
pub fn get_extension_status(
    database: State<'_, Database>,
    bridge: State<'_, Bridge>,
) -> CommandResult<Value> {
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    let id: Option<String> = c
        .query_row(
            "SELECT extension_id FROM extension_config WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let origin = id.as_deref().map(extension_origin).transpose()?;
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("bookmark-desk-connector.exe");
    Ok(
        json!({"enabled":id.is_some(),"extensionId":id,"origin":origin,"descriptorPath":bridge.path,"connectorExe":exe,"hostName":"com.bookmarkdesk.connector", "setupCommands":id.as_deref().map(|id|setup_commands(id,&exe))}),
    )
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    #[test]
    fn authentication_checks_origin_secret_and_revocation() {
        let mut c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        let id = "a".repeat(32);
        let origin = extension_origin(&id).unwrap();
        let envelope = json!({"origin":origin,"secret":"secret","request":{"op":"catalog"}});
        assert!(authenticated_process(&mut c, envelope.clone()).is_err());
        c.execute("INSERT INTO extension_config VALUES(1,?1,'secret')", [id])
            .unwrap();
        assert!(authenticated_process(&mut c, envelope.clone()).is_ok());
        let mut bad = envelope.clone();
        bad["origin"] = json!(format!("{origin}extra"));
        assert!(authenticated_process(&mut c, bad).is_err());
        let mut bad = envelope.clone();
        bad["secret"] = json!("wrong");
        assert!(authenticated_process(&mut c, bad).is_err());
        c.execute("DELETE FROM extension_config", []).unwrap();
        assert!(authenticated_process(&mut c, envelope).is_err());
    }
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    #[test]
    fn native_save_wins_against_concurrent_stale_ui_patch() {
        let c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        let revision = revision(&c).unwrap();
        let database = std::sync::Arc::new(Mutex::new(c));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let writer_db = database.clone();
        let writer_barrier = barrier.clone();
        let writer = std::thread::spawn(move || {
            let mut c = writer_db.lock().unwrap();
            process(
                &mut c,
                json!({"op":"save","url":"https://concurrent.example","requestId":"concurrent"}),
            )
            .unwrap();
            writer_barrier.wait();
        });
        barrier.wait();
        let mut c = database.lock().unwrap();
        assert_eq!(
            library_sql::apply_checked(
                &mut c,
                &library_sql::LibraryPatch::default(),
                Some(&revision)
            )
            .unwrap_err(),
            "Library revision conflict"
        );
        assert_eq!(read_library(&mut c).unwrap().bookmarks.len(), 1);
        drop(c);
        writer.join().unwrap();
    }
}

fn setup_commands(id: &str, exe: &std::path::Path) -> Value {
    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    json!({
        "shell":"PowerShell",
        "build":format!("cargo build --manifest-path {} --bins",quote(&source.join("Cargo.toml").to_string_lossy())),
        "register":format!("& {} -ExtensionId {} -Browser Both -ConnectorExe {}",quote(&source.join("setup-native-host.ps1").to_string_lossy()),quote(id),quote(&exe.to_string_lossy())),
        "unregister":format!("& {} -ExtensionId {} -Browser Both -Uninstall",quote(&source.join("setup-native-host.ps1").to_string_lossy()),quote(id))
    })
}

#[cfg(all(test, target_os = "windows"))]
mod sqlite_process_test {
    use super::*;
    use std::process::{Command, Stdio};
    struct ChildGuard(std::process::Child);
    impl std::ops::Deref for ChildGuard {
        type Target = std::process::Child;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl std::ops::DerefMut for ChildGuard {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.0
        }
    }
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    struct DirectoryGuard(PathBuf);
    impl Drop for DirectoryGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn real_subprocess_authenticated_tcp_inserts_sqlite() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("sqlite-process-{}", std::process::id()));
        let _cleanup = DirectoryGuard(root.clone());
        let directory = root.join("com.bookmarkdesk.desktop");
        std::fs::create_dir_all(&directory).unwrap();
        let mut c = Connection::open(directory.join("library.sqlite3")).unwrap();
        initialize(&c).unwrap();
        let id = "b".repeat(32);
        let origin = extension_origin(&id).unwrap();
        c.execute(
            "INSERT INTO extension_config VALUES(1,?1,lower(hex(randomblob(32))))",
            [id],
        )
        .unwrap();
        let secret: String = c
            .query_row("SELECT secret FROM extension_config", [], |r| r.get(0))
            .unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::fs::write(
            directory.join(DESCRIPTOR),
            serde_json::to_vec(&Descriptor {
                port: listener.local_addr().unwrap().port(),
                origin: origin.clone(),
                secret,
            })
            .unwrap(),
        )
        .unwrap();
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join("bookmark-desk-connector.exe");
        let child=Command::new(executable).arg(&origin).env("APPDATA",&root).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("Build debug connector with cargo build --bins before focused lib-only subprocess tests");
        let mut child = ChildGuard(child);
        let request = json!({"op":"save","url":"https://sqlite-process.example/a#one","requestId":"sqlite-process","tags":["roundtrip"]});
        write_frame(child.stdin.as_mut().unwrap(), &request).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        let _ = child.kill();
                        panic!("connector connection timed out");
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("{e}"),
            }
        };
        // Winsock accepted sockets can inherit the listener's nonblocking mode.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let envelope = read_frame(&mut stream).unwrap().unwrap();
        let result = authenticated_process(&mut c, envelope).unwrap();
        assert_eq!(result["status"], "saved");
        write_frame(&mut stream, &result).unwrap();
        assert_eq!(
            read_frame(child.stdout.as_mut().unwrap()).unwrap().unwrap(),
            result
        );
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        let library = read_library(&mut c).unwrap();
        assert_eq!(library.bookmarks.len(), 1);
        assert_eq!(library.bookmarks[0].tags, vec!["roundtrip"]);
        assert_eq!(process(&mut c, request).unwrap(), result);
        drop(c);
        std::fs::remove_dir_all(root).unwrap();
    }
}

struct DeadlineReader<'a> {
    stream: &'a mut TcpStream,
    deadline: std::time::Instant,
}
impl Read for DeadlineReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "Frame deadline exceeded")
            })?;
        self.stream
            .set_read_timeout(Some(remaining.max(Duration::from_millis(1))))?;
        self.stream.read(buf)
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    #[test]
    fn frame_deadline_and_untrusted_metadata_are_rejected() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let start = std::time::Instant::now();
        assert!(read_frame(&mut DeadlineReader {
            stream: &mut server,
            deadline: start + Duration::from_millis(50)
        })
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        for request in [
            json!({"op":"save","url":"https://invalid.example","createdAt":"not-a-date"}),
            json!({"op":"save","url":"https://invalid.example","requestId":"x".repeat(129)}),
            json!({"op":"save","url":"https://invalid.example","collectionIds":["x".repeat(257)]}),
            json!({"op":"save","url":"https://invalid.example","tags":["x".repeat(101)]}),
        ] {
            assert!(process(&mut c, request).is_err());
        }
        assert!(read_library(&mut c).unwrap().bookmarks.is_empty());
    }
}
