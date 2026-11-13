#![cfg(target_os = "windows")]
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
fn frame(w: &mut impl Write, v: &Value) {
    let b = serde_json::to_vec(v).unwrap();
    w.write_all(&(b.len() as u32).to_le_bytes()).unwrap();
    w.write_all(&b).unwrap();
    w.flush().unwrap();
}
fn read(r: &mut impl Read) -> Value {
    let mut h = [0; 4];
    r.read_exact(&mut h).unwrap();
    let len = u32::from_le_bytes(h) as usize;
    assert!(len < 512 * 1024);
    let mut b = vec![0; len];
    r.read_exact(&mut b).unwrap();
    serde_json::from_slice(&b).unwrap()
}
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
fn real_connector_frames_exact_origin_and_loopback_relay() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("native-process-{}", std::process::id()));
    let _cleanup = DirectoryGuard(root.clone());
    let dir = root.join("com.bookmarkdesk.desktop");
    std::fs::create_dir_all(&dir).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("chrome-extension://{}/", "a".repeat(32));
    let secret = "ab".repeat(32);
    std::fs::write(
        dir.join("native-connector.json"),
        json!({"port":listener.local_addr().unwrap().port(),"secret":secret,"origin":origin})
            .to_string(),
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_bookmark-desk-connector"))
        .arg(&origin)
        .env("APPDATA", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);
    let request = json!({"op":"check","url":"https://example.com"});
    frame(child.stdin.as_mut().unwrap(), &request);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    panic!("connector failed to connect");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("{e}"),
        }
    };
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let envelope = read(&mut stream);
    assert_eq!(
        envelope,
        json!({"origin":origin,"secret":secret,"request":request})
    );
    frame(&mut stream, &json!({"ok":true,"saved":false}));
    assert_eq!(
        read(child.stdout.as_mut().unwrap()),
        json!({"ok":true,"saved":false})
    );
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    let rejected = Command::new(env!("CARGO_BIN_EXE_bookmark-desk-connector"))
        .arg(format!("{origin}extra"))
        .env("APPDATA", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut rejected = ChildGuard(rejected);
    let response = read(rejected.stdout.as_mut().unwrap());
    assert_eq!(response["ok"], false);
    assert!(rejected.wait().unwrap().success());
    std::fs::remove_dir_all(root).unwrap();
}
