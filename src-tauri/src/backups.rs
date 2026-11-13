use super::*;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSettings {
    enabled: bool,
    interval_minutes: u32,
    retention: u32,
    location: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    #[serde(rename = "config", alias = "settings")]
    settings: BackupSettings,
    #[serde(serialize_with = "serialize_success")]
    last_success: Option<u64>,
    #[serde(rename = "lastError", alias = "error")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    name: String,
    created_at: u64,
    size: u64,
}

pub struct Backups(Mutex<BackupStatus>);

fn serialize_success<S: serde::Serializer>(
    value: &Option<u64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        None => serializer.serialize_none(),
        Some(ms) => {
            // Gregorian civil date from days since Unix epoch.
            let z = (ms / 86_400_000) as i64 + 719468;
            let era = z / 146097;
            let doe = z - era * 146097;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            let mut year = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let day = doy - (153 * mp + 2) / 5 + 1;
            let month = mp + if mp < 10 { 3 } else { -9 };
            year += i64::from(month <= 2);
            let seconds = ms / 1000;
            serializer.serialize_some(&format!(
                "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
                seconds / 3600 % 24,
                seconds / 60 % 60,
                seconds % 60,
                ms % 1000
            ))
        }
    }
}

#[derive(Serialize)]
pub struct BackupRead {
    version: u32,
    library: Library,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn defaults(directory: &Path) -> BackupSettings {
    BackupSettings {
        enabled: true,
        interval_minutes: 60,
        retention: 20,
        location: directory.join("backups").to_string_lossy().into_owned(),
    }
}

fn validate_settings(settings: &BackupSettings) -> CommandResult<()> {
    if !(1..=10080).contains(&settings.interval_minutes) || !(1..=100).contains(&settings.retention)
    {
        return Err("Backup interval must be 1–10080 minutes and retention 1–100".into());
    }
    if !Path::new(&settings.location).is_absolute() {
        return Err("Backup location must be an absolute local directory".into());
    }
    #[cfg(windows)]
    if settings.location.starts_with("\\\\") {
        return Err("Network and device backup locations are not supported".into());
    }
    Ok(())
}

fn unsafe_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

// Reject links/reparse points in every existing component, including the directory itself.
fn safe_directory(path: &Path, create: bool) -> CommandResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Invalid backup directory".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if !unsafe_metadata(&meta) && meta.is_dir() => (),
            Ok(_) => return Err("Backup directory contains a link or non-directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&current).map_err(|e| e.to_string())?;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn lock_directory(path: &Path) -> CommandResult<Vec<fs::File>> {
    safe_directory(path, false)?;
    let mut guards = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component);
            if !current.is_absolute() {
                continue;
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(3)
                .custom_flags(0x02000000 | 0x00200000)
                .open(&current)
                .map_err(|e| e.to_string())?;
            let meta = file.metadata().map_err(|e| e.to_string())?;
            if unsafe_metadata(&meta) || !meta.is_dir() {
                return Err("Backup directory contains a reparse point".into());
            }
            guards.push(file);
        }
    }
    Ok(guards)
}

fn valid_name(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix("bookmark-desk-backup-")
        .and_then(|s| s.strip_suffix(".json"))
    else {
        return false;
    };
    let parts: Vec<_> = body.split('-').collect();
    parts.len() == 2
        && parts[0].len() == 20
        && parts[1].len() == 20
        && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
}

fn regular_file(path: &Path) -> CommandResult<fs::Metadata> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if unsafe_metadata(&meta) || !meta.is_file() {
        return Err("Backup is not a regular owned file".into());
    }
    Ok(meta)
}

fn persist(c: &Connection, status: &BackupStatus) -> CommandResult<()> {
    let mut payload = serde_json::to_value(status).map_err(|e| e.to_string())?;
    payload["lastSuccess"] = serde_json::json!(status.last_success);
    c.execute(
        "INSERT OR REPLACE INTO backup_state(singleton,payload) VALUES(1,?1)",
        [payload.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn initialize_backups(c: &Connection, directory: &Path) -> CommandResult<BackupStatus> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS backup_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS backup_files(location TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(location,name));").map_err(|e| e.to_string())?;
    use rusqlite::OptionalExtension;
    let saved: Option<String> = c
        .query_row(
            "SELECT payload FROM backup_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let status = match saved {
        Some(json) => match decode_saved_status(&json) {
            Ok(status) => status,
            Err(error) => {
                // Preserve the exact original before persisting a disabled recovery configuration.
                c.execute_batch("CREATE TABLE IF NOT EXISTS backup_state_recovery(id INTEGER PRIMARY KEY,payload TEXT NOT NULL UNIQUE,recovered_at INTEGER NOT NULL);").map_err(|e| e.to_string())?;
                c.execute("INSERT OR IGNORE INTO backup_state_recovery(payload,recovered_at) VALUES(?1,?2)", params![json, now()]).map_err(|e| e.to_string())?;
                recovery_status(directory, &error)
            }
        },
        None => BackupStatus {
            settings: defaults(directory),
            last_success: None,
            error: None,
        },
    };
    persist(c, &status)?;
    Ok(status)
}

fn decode_saved_status(json: &str) -> CommandResult<BackupStatus> {
    let mut value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if value.get("config").is_none() && value.get("settings").is_none() {
        let object = value.as_object_mut().ok_or("Backup settings must be an object")?;
        let mut config = serde_json::Map::new();
        for key in ["enabled", "intervalMinutes", "retention", "location"] {
            if let Some(field) = object.remove(key) { config.insert(key.into(), field); }
        }
        object.insert("config".into(), serde_json::Value::Object(config));
    }
    let status: BackupStatus = serde_json::from_value(value).map_err(|e| e.to_string())?;
    validate_settings(&status.settings)?;
    Ok(status)
}

fn recovery_status(directory: &Path, error: &str) -> BackupStatus {
    let mut settings = defaults(directory);
    settings.enabled = false;
    BackupStatus {
        settings,
        last_success: None,
        error: Some(format!("Automatic backups disabled: saved backup settings could not be loaded ({error}). Original settings are preserved in backup_state / backup_state_recovery in library.sqlite3; existing backups and library are unchanged. Review and save backup settings to resume.")),
    }
}

fn due(status: &BackupStatus, timestamp: u64) -> bool {
    status.settings.enabled
        && status
            .last_success
            .map(|last| {
                timestamp.saturating_sub(last)
                    >= u64::from(status.settings.interval_minutes) * 60_000
            })
            .unwrap_or(true)
}

fn entries(c: &Connection, settings: &BackupSettings) -> CommandResult<Vec<BackupEntry>> {
    let path = Path::new(&settings.location);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let _guards = lock_directory(path)?;
    let mut statement = c.prepare("SELECT name,created_at FROM backup_files WHERE location=?1 ORDER BY created_at DESC,name DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([&settings.location], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let (name, created_at) = row.map_err(|e| e.to_string())?;
        if valid_name(&name) {
            if let Ok(meta) = regular_file(&path.join(&name)) {
                result.push(BackupEntry {
                    name,
                    created_at,
                    size: meta.len(),
                });
            }
        }
    }
    Ok(result)
}

fn retain(c: &Connection, settings: &BackupSettings) -> CommandResult<()> {
    for entry in entries(c, settings)?
        .into_iter()
        .skip(settings.retention as usize)
    {
        let directory = Path::new(&settings.location);
        let _guards = lock_directory(directory)?;
        let path = directory.join(&entry.name);
        regular_file(&path)?;
        fs::remove_file(path).map_err(|e| e.to_string())?;
        c.execute(
            "DELETE FROM backup_files WHERE location=?1 AND name=?2",
            params![settings.location, entry.name],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn atomic_write(directory: &Path, name: &str, bytes: &[u8]) -> CommandResult<()> {
    safe_directory(directory, true)?;
    let _guards = lock_directory(directory)?;
    if !valid_name(name) {
        return Err("Invalid backup filename".into());
    }
    let staging = directory.join(format!(".{name}.partial"));
    let destination = directory.join(name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        safe_directory(directory, false)?;
        // Linking a complete synced file publishes atomically without replacing any existing path.
        fs::hard_link(&staging, &destination).map_err(|e| e.to_string())
    })();
    let cleanup = fs::remove_file(&staging).map_err(|e| e.to_string());
    result.and(cleanup)
}

fn create(c: &mut Connection, status: &mut BackupStatus) -> CommandResult<BackupEntry> {
    let result = (|| {
        let library = read_library(c)?;
        let bytes = serde_json::to_vec_pretty(&library).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Backup exceeds 128 MiB limit".into());
        }
        let timestamp = now();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let name = format!("bookmark-desk-backup-{timestamp:020}-{nonce:020}.json");
        atomic_write(Path::new(&status.settings.location), &name, &bytes)?;
        c.execute(
            "INSERT INTO backup_files(location,name,created_at) VALUES(?1,?2,?3)",
            params![status.settings.location, name, timestamp],
        )
        .map_err(|e| e.to_string())?;
        status.last_success = Some(timestamp);
        retain(c, &status.settings)?;
        Ok(BackupEntry {
            name,
            created_at: timestamp,
            size: bytes.len() as u64,
        })
    })();
    status.error = result.as_ref().err().cloned();
    persist(c, status)?;
    result
}

fn read(c: &Connection, settings: &BackupSettings, name: &str) -> CommandResult<Library> {
    if !valid_name(name) {
        return Err("Invalid backup filename".into());
    }
    let owned: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM backup_files WHERE location=?1 AND name=?2)",
            params![settings.location, name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !owned {
        return Err("Backup is not owned by this application".into());
    }
    let directory = Path::new(&settings.location);
    let _guards = lock_directory(directory)?;
    let path = directory.join(name);
    let metadata = regular_file(&path)?;
    if metadata.len() > MAX_BYTES {
        return Err("Backup exceeds 128 MiB limit".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if unsafe_metadata(&opened) || !opened.is_file() {
        return Err("Backup is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Backup exceeds 128 MiB limit".into());
    }
    let library: Library =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid backup JSON: {e}"))?;
    for ids in [
        library
            .bookmarks
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        library
            .trash
            .iter()
            .map(|b| b.bookmark.id.as_str())
            .collect(),
        library.collections.iter().map(|c| c.id.as_str()).collect(),
    ] {
        let mut seen = HashSet::new();
        if ids
            .iter()
            .any(|id| id.trim().is_empty() || !seen.insert(*id))
        {
            return Err("Invalid backup IDs".into());
        }
    }
    library_sql::validate_smart_collections(&library.smart_collections, &[])?;
    Ok(library)
}

#[tauri::command]
pub fn backup_status(backups: State<'_, Backups>) -> CommandResult<BackupStatus> {
    Ok(backups
        .0
        .lock()
        .map_err(|_| "Backup lock unavailable")?
        .clone())
}

#[tauri::command]
pub fn configure_backups(
    backups: State<'_, Backups>,
    database: State<'_, Database>,
    config: BackupSettings,
) -> CommandResult<BackupStatus> {
    let settings = config;
    let mut status = backups.0.lock().map_err(|_| "Backup lock unavailable")?;
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    if let Err(error) = validate_settings(&settings)
        .and_then(|_| safe_directory(Path::new(&settings.location), true))
    {
        status.error = Some(error.clone());
        persist(&c, &status)?;
        return Err(error);
    }
    let updated = BackupStatus {
        settings,
        last_success: status.last_success,
        error: None,
    };
    persist(&c, &updated)?;
    *status = updated;
    Ok(status.clone())
}

#[tauri::command]
pub fn list_backups(
    backups: State<'_, Backups>,
    database: State<'_, Database>,
) -> CommandResult<Vec<BackupEntry>> {
    let mut status = backups.0.lock().map_err(|_| "Backup lock unavailable")?;
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    let result = entries(&c, &status.settings);
    if let Err(error) = &result {
        status.error = Some(error.clone());
        persist(&c, &status)?;
    }
    result
}

#[tauri::command]
pub fn create_backup(
    backups: State<'_, Backups>,
    database: State<'_, Database>,
) -> CommandResult<BackupStatus> {
    let mut status = backups.0.lock().map_err(|_| "Backup lock unavailable")?;
    let mut c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    create(&mut c, &mut status)?;
    Ok(status.clone())
}

#[tauri::command]
pub fn read_backup(
    backups: State<'_, Backups>,
    database: State<'_, Database>,
    name: String,
) -> CommandResult<BackupRead> {
    let mut status = backups.0.lock().map_err(|_| "Backup lock unavailable")?;
    let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
    match read(&c, &status.settings, &name) {
        Ok(library) => Ok(BackupRead {
            version: 1,
            library,
        }),
        Err(error) => {
            status.error = Some(error.clone());
            persist(&c, &status)?;
            Err(error)
        }
    }
}

pub fn start(app: &tauri::AppHandle, directory: &Path) -> CommandResult<()> {
    let status = {
        let database = app.state::<Database>();
        let c = database.0.lock().map_err(|_| "Database lock unavailable")?;
        initialize_backups(&c, directory).unwrap_or_else(|error| recovery_status(directory, &error))
    };
    app.manage(Backups(Mutex::new(status)));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let backups = handle.state::<Backups>();
                let database = handle.state::<Database>();
                if let Ok(mut status) = backups.0.lock() {
                    if due(&status, now()) {
                        if let Ok(mut c) = database.0.lock() {
                            let _ = create(&mut c, &mut status);
                        }
                    }
                };
            })
            .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, PathBuf, BackupStatus) {
        let directory = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "backup-tests-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let c = Connection::open(directory.join("test.sqlite3")).unwrap();
        initialize(&c).unwrap();
        let status = initialize_backups(&c, &directory).unwrap();
        (c, directory, status)
    }
    #[test]
    fn inspect_saved_settings_read_only_when_requested() {
        let Ok(path) = std::env::var("BOOKMARK_DESK_INSPECT_SETTINGS_DB") else { return };
        let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let original: String = c.query_row("SELECT payload FROM backup_state WHERE singleton=1", [], |r| r.get(0)).unwrap();
        let status = decode_saved_status(&original).expect("actual saved settings must migrate without recovery");
        let mut canonical = serde_json::to_value(&status).unwrap();
        canonical["lastSuccess"] = serde_json::json!(status.last_success);
        let roundtrip = decode_saved_status(&canonical.to_string()).unwrap();
        assert_eq!(roundtrip.settings, status.settings);
        assert_eq!(roundtrip.last_success, status.last_success);
        assert_eq!(roundtrip.error, status.error);
        let unchanged: String = c.query_row("SELECT payload FROM backup_state WHERE singleton=1", [], |r| r.get(0)).unwrap();
        assert_eq!(unchanged, original);
    }

    #[test]
    fn migrates_intermediate_and_flat_settings_without_losing_values() {
        let (c, dir, mut status) = fixture();
        status.settings.enabled = false;
        status.settings.interval_minutes = 17;
        status.settings.retention = 7;
        status.last_success = Some(1794553082832);
        status.error = Some("Previous backup error".into());
        let config = serde_json::to_value(&status.settings).unwrap();
        let mut flat = config.clone();
        flat["lastSuccess"] = serde_json::json!(status.last_success);
        flat["error"] = serde_json::json!(status.error);
        let intermediate = serde_json::json!({"settings": config, "lastSuccess": status.last_success, "error": status.error});
        for value in [flat, intermediate] {
            c.execute("UPDATE backup_state SET payload=?1", [value.to_string()]).unwrap();
            let loaded = initialize_backups(&c, &dir).unwrap();
            assert_eq!(loaded.settings, status.settings);
            assert_eq!(loaded.last_success, status.last_success);
            assert_eq!(loaded.error, status.error);
            let canonical: String = c.query_row("SELECT payload FROM backup_state", [], |r| r.get(0)).unwrap();
            assert!(serde_json::from_str::<serde_json::Value>(&canonical).unwrap().get("config").is_some());
            let restarted = initialize_backups(&c, &dir).unwrap();
            assert_eq!(restarted.settings, status.settings);
            assert_eq!(restarted.last_success, status.last_success);
        }
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_settings_recover_disabled_and_preserve_original_and_library() {
        let (mut c, dir, mut status) = fixture();
        write_library(&mut c, &crate::tests::sample()).unwrap();
        let name = create(&mut c, &mut status).unwrap().name;
        let snapshot = fs::read(Path::new(&status.settings.location).join(&name)).unwrap();
        let before = read_library(&mut c).unwrap();
        let invalid_settings = serde_json::json!({"config": {"enabled": true, "intervalMinutes": 0, "retention": 900, "location": status.settings.location}}).to_string();
        for original in ["{truncated".to_string(), invalid_settings, "null".into(), "{}".into()] {
            c.execute("UPDATE backup_state SET payload=?1", [&original]).unwrap();
            let loaded = initialize_backups(&c, &dir).unwrap();
            assert!(!loaded.settings.enabled);
            assert!(!due(&loaded, u64::MAX));
            assert!(loaded.error.as_deref().unwrap().contains("Original settings are preserved"));
            let preserved: String = c.query_row("SELECT payload FROM backup_state_recovery WHERE payload=?1", [&original], |r| r.get(0)).unwrap();
            assert_eq!(preserved, original);
            assert_eq!(read_library(&mut c).unwrap(), before);
            assert_eq!(fs::read(Path::new(&status.settings.location).join(&name)).unwrap(), snapshot);
            assert_eq!(entries(&c, &status.settings).unwrap().len(), 1);
            let restarted = initialize_backups(&c, &dir).unwrap();
            assert!(!restarted.settings.enabled);
            assert_eq!(restarted.error, loaded.error);
        }
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scheduling_and_settings_persist() {
        let (c, dir, mut status) = fixture();
        assert!(due(&status, 0));
        status.last_success = Some(1000);
        assert!(!due(&status, 1001));
        assert!(due(&status, 3_601_000));
        status.settings.enabled = false;
        status.settings.interval_minutes = 5;
        status.settings.retention = 3;
        status.error = Some("test error".into());
        persist(&c, &status).unwrap();
        drop(c);
        let c = Connection::open(dir.join("test.sqlite3")).unwrap();
        let loaded = initialize_backups(&c, &dir).unwrap();
        assert_eq!(loaded.settings, status.settings);
        assert_eq!(loaded.last_success, Some(1000));
        assert_eq!(loaded.error, status.error);
        assert!(!due(&loaded, u64::MAX));
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn retention_and_safe_merge_read() {
        let (mut c, dir, mut status) = fixture();
        status.settings.retention = 2;
        write_library(&mut c, &crate::tests::sample()).unwrap();
        let first = create(&mut c, &mut status).unwrap();
        let second = create(&mut c, &mut status).unwrap();
        let user_file = Path::new(&status.settings.location).join("user.json");
        fs::write(&user_file, b"do not delete").unwrap();
        let third = create(&mut c, &mut status).unwrap();
        assert_eq!(entries(&c, &status.settings).unwrap().len(), 2);
        assert!(!Path::new(&status.settings.location)
            .join(first.name)
            .exists());
        assert!(user_file.exists());
        assert_eq!(
            read(&c, &status.settings, &second.name).unwrap(),
            crate::tests::sample()
        );
        assert_eq!(read_library(&mut c).unwrap(), crate::tests::sample());
        for name in [
            "../library.sqlite3",
            "C:\\library.json",
            "user.json",
            "bookmark-desk-backup-00000000000000000000-00000000000000000000.json",
        ] {
            assert!(read(&c, &status.settings, name).is_err());
        }
        fs::write(
            Path::new(&status.settings.location).join(&third.name),
            b"{}",
        )
        .unwrap();
        assert!(read(&c, &status.settings, &third.name).is_err());
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn atomic_errors_leave_existing_file_and_report_status() {
        let (mut c, dir, mut status) = fixture();
        let name = "bookmark-desk-backup-00000000000000000000-00000000000000000000.json";
        let backup_dir = Path::new(&status.settings.location);
        safe_directory(backup_dir, true).unwrap();
        fs::write(backup_dir.join(name), b"original").unwrap();
        assert!(atomic_write(backup_dir, name, b"replacement").is_err());
        assert_eq!(fs::read(backup_dir.join(name)).unwrap(), b"original");
        assert!(!backup_dir.join(format!(".{name}.partial")).exists());
        status.settings.location = dir.join("blocked").to_string_lossy().into_owned();
        fs::write(&status.settings.location, b"blocked").unwrap();
        assert!(create(&mut c, &mut status).is_err());
        assert!(status.error.is_some());
        assert!(status.last_success.is_none());
        assert!(initialize_backups(&c, &dir).unwrap().error.is_some());
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn wire_status_uses_iso_timestamp_and_config() {
        let (_, dir, mut status) = fixture();
        status.last_success = Some(1_794_550_800_123);
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["lastSuccess"], "2026-11-13T06:20:00.123Z");
        assert!(json.get("config").is_some());
        assert!(json.get("lastError").is_some());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn links_are_never_read_or_retained() {
        let (mut c, dir, mut status) = fixture();
        let entry = create(&mut c, &mut status).unwrap();
        let path = Path::new(&status.settings.location).join(&entry.name);
        let outside = dir.join("outside.json");
        fs::rename(&path, &outside).unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, &path);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &path);
        if linked.is_ok() {
            assert!(read(&c, &status.settings, &entry.name).is_err());
            assert!(entries(&c, &status.settings).unwrap().is_empty());
            retain(&c, &status.settings).unwrap();
            assert!(outside.exists());
            fs::remove_file(path).unwrap();
        }
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refuses_directory_in_place_of_owned_backup() {
        let (mut c, dir, mut status) = fixture();
        let entry = create(&mut c, &mut status).unwrap();
        let path = Path::new(&status.settings.location).join(&entry.name);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(read(&c, &status.settings, &entry.name).is_err());
        assert!(entries(&c, &status.settings).unwrap().is_empty());
        retain(&c, &status.settings).unwrap();
        assert!(path.is_dir());
        drop(c);
        fs::remove_dir_all(dir).unwrap();
    }
}
