use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
fn read(stream: &mut TcpStream) -> Value {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut header = [0; 4];
    stream.read_exact(&mut header).unwrap();
    let mut body = vec![0; u32::from_be_bytes(header) as usize];
    assert!(body.len() < 16384);
    stream.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}
fn write(stream: &mut TcpStream, result: Value) {
    let bytes = serde_json::to_vec(&json!({"id":null,"result":result})).unwrap();
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(&bytes).unwrap();
}
#[test]
fn cli_two_patches_ordered_eof_closes_and_no_token_output() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        assert_eq!(read(&mut stream)["method"], "authenticate");
        write(&mut stream, json!({"authenticated":true}));
        assert_eq!(read(&mut stream)["method"], "dev.status");
        write(
            &mut stream,
            json!({"version":1,"generation":9,"enabled":true,"opened":true,"sessionId":"b".repeat(32),"initialBundleSha256":"c".repeat(64),"revision":"initial","acceptedSequence":"0","pending":false,"reloadRequired":false}),
        );
        for (sequence, base, target) in [("1", "initial", "next"), ("2", "next", "last")] {
            let p = read(&mut stream);
            assert_eq!(p["sequence"], sequence);
            assert_eq!(p["baseRevision"], base);
            assert_eq!(p["targetRevision"], target);
            write(
                &mut stream,
                json!({"status":"queued","sequence":sequence,"baseRevision":base,"targetRevision":target,"payloadSha256":"d".repeat(64)}),
            );
            assert_eq!(read(&mut stream)["method"], "dev.drain");
            write(
                &mut stream,
                json!({"status":"applied","sequence":sequence,"baseRevision":base,"targetRevision":target,"payloadSha256":"d".repeat(64),"generation":9,"appliedRevision":target,"phase":"mount-submitted","reloadRequired":false,"message":""}),
            );
        }
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).unwrap(), 0);
    });
    let directory = std::env::temp_dir().join(format!("nh-refresh-cli-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let config = directory.join("config.json");
    let payload = directory.join("patch.js");
    std::fs::write(&payload, "({status:'applied'})").unwrap();
    std::fs::write(&config,json!({"schemaVersion":1,"host":"127.0.0.1","port":port,"token":"a".repeat(64),"sessionId":"b".repeat(32),"initialRevision":"initial","initialBundleSha256":"c".repeat(64)}).to_string()).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_native-host-refresh-transport"))
        .arg("--config")
        .arg(&config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for (sequence, base, target) in [("1", "initial", "next"), ("2", "next", "last")] {
        writeln!(input,"{}",json!({"method":"patch","sequence":sequence,"baseRevision":base,"targetRevision":target,"payloadSha256":"d".repeat(64),"payloadFile":payload})).unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["event"], "ready");
    assert_eq!(lines[1]["result"]["sequence"], "1");
    assert_eq!(lines[2]["result"]["sequence"], "2");
    assert!(!stdout.contains(&"a".repeat(64)));
    assert!(output.stderr.is_empty());
    server.join().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
