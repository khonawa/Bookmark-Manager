use super::*;
use rusqlite::functions::FunctionFlags;
use rusqlite::OptionalExtension;
use std::collections::HashSet;

pub(super) fn install(connection: &Connection) -> rusqlite::Result<()> {
    connection.create_scalar_function(
        "bookmark_domain",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let value: String = context.get(0)?;
            Ok(url::Url::parse(&value)
                .ok()
                .and_then(|url| url.host_str().map(|host| normalize_domain(host)))
                .unwrap_or_default())
        },
    )?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS bookmarks_newest ON bookmarks(created_at DESC, id);
         CREATE INDEX IF NOT EXISTS bookmarks_title ON bookmarks(title COLLATE NOCASE, id);
         CREATE INDEX IF NOT EXISTS bookmarks_domain ON bookmarks(bookmark_domain(url), id);
         CREATE INDEX IF NOT EXISTS bookmarks_position ON bookmarks(position);
         CREATE INDEX IF NOT EXISTS collections_position ON collections(position);
         CREATE INDEX IF NOT EXISTS trash_position ON trash(position);
         CREATE INDEX IF NOT EXISTS smart_collections_position ON smart_collections(position);",
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    bookmarks: Vec<serde_json::Value>,
    total: i64,
}

fn normalize_domain(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

#[cfg(test)]
pub(super) fn query(
    connection: &mut Connection,
    view: &str,
    tag: &str,
    query: &str,
    sort: &str,
    page: i64,
) -> CommandResult<QueryResult> {
    query_rows(
        connection,
        &QueryInput {
            view: view.into(),
            tag: tag.into(),
            query: query.into(),
            sort: sort.into(),
            page,
            domain: String::new(),
        },
        None,
    )
    .map(|r| r.0)
}

fn query_rows(
    connection: &mut Connection,
    input: &QueryInput,
    expected_revision: Option<&str>,
) -> CommandResult<(QueryResult, Vec<String>)> {
    let order = match input.sort.as_str() {
        "newest" => "created_at DESC, id ASC",
        "title" => "title COLLATE NOCASE ASC, id ASC",
        "domain" => "bookmark_domain(url) ASC, id ASC",
        _ => return Err("sort must be newest, title, or domain".into()),
    };
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    if let Some(expected) = expected_revision {
        if connector::revision(&transaction)? != expected {
            return Err("Library revision conflict".into());
        }
    }
    let smart_id = input.view.strip_prefix("smart:");
    let rules = if let Some(id) = smart_id {
        let json: Option<String> = transaction
            .query_row(
                "SELECT rules_json FROM smart_collections WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match json {
            Some(json) => serde_json::from_str::<SmartRules>(&json).map_err(|e| e.to_string())?,
            None => {
                return Ok((
                    QueryResult {
                        bookmarks: Vec::new(),
                        total: 0,
                    },
                    Vec::new(),
                ))
            }
        }
    } else {
        SmartRules::default()
    };
    let source = if input.view == "trash" {
        "SELECT id, json_extract(payload_json,'$.title') AS title, json_extract(payload_json,'$.url') AS url,
         json_extract(payload_json,'$.description') AS description, json_extract(payload_json,'$.tags') AS tags_json,
         json_extract(payload_json,'$.collectionIds') AS collection_ids_json,
         json_extract(payload_json,'$.createdAt') AS created_at, payload_json AS payload FROM trash"
    } else {
        "SELECT id,title,url,description,tags_json,collection_ids_json,created_at,
         json_object('id',id,'title',title,'url',url,'description',description,'tags',json(tags_json),
         'collectionIds',json(collection_ids_json),'createdAt',created_at) AS payload FROM bookmarks"
    };
    let collection = input
        .view
        .strip_prefix("collection:")
        .unwrap_or(&input.view);
    let filter = " WHERE
        (?1 IN ('all','trash') OR ?5 OR (?1='inbox' AND json_array_length(collection_ids_json)=0)
         OR (?1='untagged' AND json_array_length(tags_json)=0)
         OR (?1 NOT IN ('all','trash','inbox','untagged') AND EXISTS(SELECT 1 FROM json_each(collection_ids_json) WHERE value=?2)))
        AND (?3='' OR EXISTS(SELECT 1 FROM json_each(tags_json) WHERE value=?3))
        AND (?4='' OR instr(lower(search_text),lower(?4))>0)
        AND (?6='' OR bookmark_domain(url)=?6)
        AND (?7='' OR instr(lower(search_text),lower(?7))>0)
        AND NOT EXISTS(SELECT 1 FROM json_each(?8) wanted WHERE NOT EXISTS(SELECT 1 FROM json_each(tags_json) actual WHERE actual.value=wanted.value))
        AND (?9='' OR bookmark_domain(url)=?9)
        AND (NOT ?10 OR json_array_length(tags_json)=0)
        AND (NOT ?11 OR json_array_length(collection_ids_json)=0)";
    let base = format!("WITH source AS ({source}), items AS (SELECT *, title || ' ' || url || ' ' || description || ' ' || coalesce((SELECT group_concat(value,' ') FROM json_each(tags_json)), '') AS search_text FROM source)");
    let tags = serde_json::to_string(&rules.tags).map_err(|e| e.to_string())?;
    let domain = normalize_domain(&input.domain);
    let smart_domain = normalize_domain(&rules.domain);
    let values = params![
        input.view,
        collection,
        input.tag,
        input.query.trim(),
        smart_id.is_some(),
        domain,
        rules.text.trim(),
        tags,
        smart_domain,
        rules.untagged,
        rules.inbox
    ];
    let total: i64 = transaction
        .query_row(
            &format!("{base} SELECT count(*) FROM items {filter}"),
            values,
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut bookmarks = Vec::new();
    let mut ids = Vec::new();
    {
        let sql = if expected_revision.is_some() {
            format!("{base} SELECT id FROM items {filter} ORDER BY {order}")
        } else {
            let last_page = (total.saturating_sub(1) / 75).max(0);
            let offset = input.page.clamp(0, last_page) * 75;
            format!("{base} SELECT payload FROM items {filter} ORDER BY {order} LIMIT 75 OFFSET {offset}")
        };
        let mut statement = transaction.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(values, |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let value = row.map_err(|e| e.to_string())?;
            if expected_revision.is_some() {
                ids.push(value);
            } else {
                bookmarks.push(serde_json::from_str(&value).map_err(|e| e.to_string())?);
            }
        }
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok((QueryResult { bookmarks, total }, ids))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPatch {
    bookmarks: Vec<Bookmark>,
    collections: Vec<Collection>,
    smart_collections: Vec<SmartCollection>,
    deleted_smart_collection_ids: Vec<String>,
    trash: Vec<TrashedBookmark>,
    deleted_bookmark_ids: Vec<String>,
    deleted_collection_ids: Vec<String>,
    deleted_trash_ids: Vec<String>,
}

fn validate_ids<'a>(
    upserts: impl Iterator<Item = &'a str>,
    deletes: &'a [String],
) -> CommandResult<()> {
    let mut seen = HashSet::new();
    for id in upserts.chain(deletes.iter().map(String::as_str)) {
        if id.trim().is_empty() || !seen.insert(id) {
            return Err("Patch IDs must be nonempty, unique, and not both upserted and deleted in the same table".into());
        }
    }
    Ok(())
}

pub(super) fn validate_smart_collections(
    collections: &[SmartCollection],
    deletes: &[String],
) -> CommandResult<()> {
    validate_ids(collections.iter().map(|c| c.id.as_str()), deletes)
}

pub(super) fn apply(connection: &mut Connection, patch: &LibraryPatch) -> CommandResult<()> {
    validate_ids(
        patch.bookmarks.iter().map(|b| b.id.as_str()),
        &patch.deleted_bookmark_ids,
    )?;
    validate_ids(
        patch.collections.iter().map(|c| c.id.as_str()),
        &patch.deleted_collection_ids,
    )?;
    validate_ids(
        patch.trash.iter().map(|b| b.bookmark.id.as_str()),
        &patch.deleted_trash_ids,
    )?;
    validate_smart_collections(
        &patch.smart_collections,
        &patch.deleted_smart_collection_ids,
    )?;
    let active: HashSet<_> = patch.bookmarks.iter().map(|b| &b.id).collect();
    if patch.trash.iter().any(|b| active.contains(&b.bookmark.id)) {
        return Err("Cannot upsert the same ID as active and trash".into());
    }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    for (table, ids) in [
        ("bookmarks", &patch.deleted_bookmark_ids),
        ("collections", &patch.deleted_collection_ids),
        ("trash", &patch.deleted_trash_ids),
        ("smart_collections", &patch.deleted_smart_collection_ids),
    ] {
        let mut statement = transaction
            .prepare_cached(&format!("DELETE FROM {table} WHERE id=?1"))
            .map_err(|e| e.to_string())?;
        for id in ids {
            statement.execute([id]).map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction.prepare_cached(
            "INSERT INTO bookmarks(id,title,url,description,tags_json,collection_ids_json,created_at,position)
             VALUES(?1,?2,?3,?4,?5,?6,?7,(SELECT coalesce(max(position),-1)+1 FROM bookmarks))
             ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,description=excluded.description,
             tags_json=excluded.tags_json,collection_ids_json=excluded.collection_ids_json,created_at=excluded.created_at
             WHERE (bookmarks.title,bookmarks.url,bookmarks.description,bookmarks.tags_json,bookmarks.collection_ids_json,bookmarks.created_at)
             IS NOT (excluded.title,excluded.url,excluded.description,excluded.tags_json,excluded.collection_ids_json,excluded.created_at)"
        ).map_err(|e| e.to_string())?;
        for b in &patch.bookmarks {
            statement
                .execute(params![
                    b.id,
                    b.title,
                    b.url,
                    b.description,
                    serde_json::to_string(&b.tags).map_err(|e| e.to_string())?,
                    serde_json::to_string(&b.collection_ids).map_err(|e| e.to_string())?,
                    b.created_at
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction.prepare_cached(
            "INSERT INTO collections(id,name,parent_id,position) VALUES(?1,?2,?3,(SELECT coalesce(max(position),-1)+1 FROM collections))
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id
             WHERE (collections.name,collections.parent_id) IS NOT (excluded.name,excluded.parent_id)"
        ).map_err(|e|e.to_string())?;
        for c in &patch.collections {
            statement
                .execute(params![c.id, c.name, c.parent_id])
                .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction.prepare_cached(
            "INSERT INTO smart_collections(id,name,rules_json,position) VALUES(?1,?2,?3,(SELECT coalesce(max(position),-1)+1 FROM smart_collections))
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,rules_json=excluded.rules_json
             WHERE (smart_collections.name,smart_collections.rules_json) IS NOT (excluded.name,excluded.rules_json)"
        ).map_err(|e| e.to_string())?;
        for c in &patch.smart_collections {
            statement
                .execute(params![
                    c.id,
                    c.name,
                    serde_json::to_string(&c.rules).map_err(|e| e.to_string())?
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut statement = transaction.prepare_cached(
            "INSERT INTO trash(id,payload_json,position) VALUES(?1,?2,(SELECT coalesce(max(position),-1)+1 FROM trash))
             ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json WHERE trash.payload_json IS NOT excluded.payload_json"
        ).map_err(|e|e.to_string())?;
        for b in &patch.trash {
            statement
                .execute(params![
                    b.bookmark.id,
                    serde_json::to_string(b).map_err(|e| e.to_string())?
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryInput {
    view: String,
    tag: String,
    query: String,
    sort: String,
    page: i64,
    #[serde(default)]
    domain: String,
}

#[tauri::command]
pub fn query_bookmarks(
    database: State<'_, Database>,
    input: QueryInput,
) -> CommandResult<QueryResult> {
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "Database lock unavailable".to_string())?;
    query_rows(&mut connection, &input, None).map(|result| result.0)
}

#[tauri::command]
pub fn query_bookmark_ids(
    database: State<'_, Database>,
    input: QueryInput,
    expected_revision: String,
) -> CommandResult<Vec<String>> {
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "Database lock unavailable".to_string())?;
    query_rows(&mut connection, &input, Some(&expected_revision)).map(|result| result.1)
}

#[tauri::command]
pub fn apply_library_patch(
    database: State<'_, Database>,
    patch: LibraryPatch,
    expected_revision: Option<String>,
) -> CommandResult<String> {
    let mut connection = database
        .0
        .lock()
        .map_err(|_| "Database lock unavailable".to_string())?;
    apply_checked(&mut connection, &patch, expected_revision.as_deref())
}

pub(super) fn apply_checked(
    connection: &mut Connection,
    patch: &LibraryPatch,
    expected_revision: Option<&str>,
) -> CommandResult<String> {
    if let Some(expected) = expected_revision {
        if connector::revision(connection)? != expected {
            return Err("Library revision conflict".into());
        }
    }
    apply(connection, patch)?;
    connector::revision(connection)
}

#[cfg(test)]
mod tests;
