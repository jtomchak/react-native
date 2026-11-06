use super::*;
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

fn config(port: u16) -> Config {
    Config {
        port,
        token: "a".repeat(64),
        session: "b".repeat(32),
        initial_revision: "initial".into(),
        initial_hash: "c".repeat(64),
    }
}
fn status(revision: &str, sequence: u64, pending: bool) -> Value {
    json!({"version":1,"generation":7,"enabled":true,"opened":true,"sessionId":"b".repeat(32),
        "initialBundleSha256":"c".repeat(64),"revision":revision,"acceptedSequence":sequence.to_string(),
        "pending":pending,"reloadRequired":false})
}
fn respond(stream: &mut TcpStream, value: Value) {
    send(stream, &json!({"id":null,"result":value})).unwrap();
}
fn handshake(listener: &TcpListener, state: Value) -> TcpStream {
    let (mut stream, _) = listener.accept().unwrap();
    let auth = receive(&mut stream).unwrap();
    assert_eq!(
        auth,
        json!({"method":"authenticate","token":"a".repeat(64)})
    );
    respond(&mut stream, json!({"authenticated":true}));
    assert_eq!(
        receive(&mut stream).unwrap(),
        json!({"method":"dev.status"})
    );
    respond(&mut stream, state);
    stream
}
fn setup(server: impl FnOnce(TcpListener) + Send + 'static) -> (Config, thread::JoinHandle<()>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let config = config(listener.local_addr().unwrap().port());
    (config, thread::spawn(move || server(listener)))
}
fn patch(sequence: u64, base: &str, target: &str) -> Patch {
    Patch {
        sequence,
        base: base.into(),
        target: target.into(),
        hash: "d".repeat(64),
        source: b"({status:'applied'})".to_vec(),
    }
}
fn ack(patch: &Value, terminal: &str) -> Value {
    let mut value = json!({"status":terminal,"sequence":patch["sequence"],"baseRevision":patch["baseRevision"],
        "targetRevision":patch["targetRevision"],"payloadSha256":patch["payloadSha256"]});
    if terminal != "queued" {
        value["generation"] = json!(7);
        value["appliedRevision"] = if terminal == "applied" {
            patch["targetRevision"].clone()
        } else {
            patch["baseRevision"].clone()
        };
        value["phase"] = json!(match terminal {
            "applied" => "mount-submitted",
            "rejected" => "prepare",
            _ => "evaluate",
        });
        value["reloadRequired"] = json!(terminal == "reload-required");
        value["message"] = json!("");
    }
    value
}
fn complete(stream: &mut TcpStream, expected_sequence: &str, terminal: &str) -> Value {
    let patch = receive(stream).unwrap();
    assert_eq!(patch["method"], "dev.enqueue");
    assert_eq!(patch["sequence"], expected_sequence);
    respond(stream, ack(&patch, "queued"));
    assert_eq!(receive(stream).unwrap(), json!({"method":"dev.drain"}));
    respond(stream, ack(&patch, terminal));
    patch
}

#[test]
fn ordered_patches_no_coalescing_and_prepare_consumes_sequence() {
    let (config, server) = setup(|listener| {
        let mut stream = handshake(&listener, status("initial", 0, false));
        complete(&mut stream, "1", "rejected");
        let second = complete(&mut stream, "2", "applied");
        assert_eq!(second["baseRevision"], "initial");
        let third = complete(&mut stream, "3", "applied");
        assert_eq!(third["baseRevision"], "second");
    });
    let mut client = Client::connect(config).unwrap();
    assert_eq!(client.ready()["sequence"], "1");
    assert!(client.patch(patch(2, "initial", "skipped")).is_err());
    assert!(client.patch(patch(1, "wrong-base", "first")).is_err());
    assert_eq!(
        client.patch(patch(1, "initial", "bad")).unwrap()["result"]["status"],
        "rejected"
    );
    assert_eq!(client.ready()["sequence"], "2");
    assert_eq!(client.ready()["revision"], "initial");
    client.patch(patch(2, "initial", "second")).unwrap();
    client.patch(patch(3, "second", "third")).unwrap();
    assert_eq!(client.ready()["revision"], "third");
    drop(client);
    server.join().unwrap();
}
#[test]
fn lost_queued_ack_replays_identical_payload() {
    let (config, server) = setup(|listener| {
        let mut first = handshake(&listener, status("initial", 0, false));
        let original = receive(&mut first).unwrap();
        drop(first);
        let mut second = handshake(&listener, status("initial", 1, true));
        let replay = receive(&mut second).unwrap();
        assert_eq!(replay, original);
        respond(&mut second, ack(&replay, "queued"));
        assert_eq!(receive(&mut second).unwrap()["method"], "dev.drain");
        respond(&mut second, ack(&replay, "applied"));
    });
    let mut client = Client::connect(config).unwrap();
    assert_eq!(
        client.patch(patch(1, "initial", "next")).unwrap()["result"]["status"],
        "applied"
    );
    drop(client);
    server.join().unwrap();
}
#[test]
fn lost_applied_ack_returns_cached_terminal_without_second_drain() {
    let (config, server) = setup(|listener| {
        let mut first = handshake(&listener, status("initial", 0, false));
        let original = receive(&mut first).unwrap();
        respond(&mut first, ack(&original, "queued"));
        assert_eq!(receive(&mut first).unwrap()["method"], "dev.drain");
        drop(first);
        let mut second = handshake(&listener, status("next", 1, false));
        let replay = receive(&mut second).unwrap();
        assert_eq!(original, replay);
        respond(&mut second, ack(&replay, "applied"));
        // Client is dropped after terminal acknowledgement; it must not drain idle.
        let mut byte = [0];
        assert_eq!(second.read(&mut byte).unwrap(), 0);
    });
    let mut client = Client::connect(config).unwrap();
    client.patch(patch(1, "initial", "next")).unwrap();
    assert_eq!(client.ready()["sequence"], "2");
    drop(client);
    server.join().unwrap();
}
#[test]
fn lost_prepare_ack_keeps_base_and_replays_rejection() {
    let (config, server) = setup(|listener| {
        let mut first = handshake(&listener, status("initial", 0, false));
        let original = receive(&mut first).unwrap();
        respond(&mut first, ack(&original, "queued"));
        receive(&mut first).unwrap();
        drop(first);
        let mut second = handshake(&listener, status("initial", 1, false));
        let replay = receive(&mut second).unwrap();
        assert_eq!(replay, original);
        respond(&mut second, ack(&replay, "rejected"));
    });
    let mut client = Client::connect(config).unwrap();
    assert_eq!(
        client.patch(patch(1, "initial", "bad")).unwrap()["result"]["status"],
        "rejected"
    );
    assert_eq!(client.ready()["revision"], "initial");
    assert_eq!(client.ready()["sequence"], "2");
    drop(client);
    server.join().unwrap();
}
#[test]
fn reconnect_identity_and_unknown_history_refused() {
    for replacement in [
        json!({"generation":8}),
        json!({"sessionId":"e".repeat(32)}),
        json!({"revision":"unrelated"}),
        json!({"acceptedSequence":"2"}),
        json!({"reloadRequired":true}),
    ] {
        let (config, server) = setup(move |listener| {
            let mut first = handshake(&listener, status("initial", 0, false));
            receive(&mut first).unwrap();
            drop(first);
            let mut state = status("initial", 1, true);
            for (key, value) in replacement.as_object().unwrap() {
                state[key] = value.clone();
            }
            let mut second = handshake(&listener, state);
            let mut byte = [0];
            assert_eq!(second.read(&mut byte).unwrap(), 0);
        });
        let mut client = Client::connect(config).unwrap();
        assert!(client.patch(patch(1, "initial", "next")).is_err());
        assert!(client.stopped());
        drop(client);
        server.join().unwrap();
    }
}
#[test]
fn retry_at_most_once() {
    let (config, server) = setup(|listener| {
        let mut first = handshake(&listener, status("initial", 0, false));
        let original = receive(&mut first).unwrap();
        drop(first);
        let mut second = handshake(&listener, status("initial", 0, false));
        assert_eq!(receive(&mut second).unwrap(), original);
        drop(second);
    });
    let mut client = Client::connect(config).unwrap();
    assert!(client.patch(patch(1, "initial", "next")).is_err());
    assert!(client.stopped());
    drop(client);
    server.join().unwrap();
}
#[test]
fn startup_rejects_wrong_identity_and_process_restart_history() {
    for replacement in [
        json!({"sessionId":"e".repeat(32)}),
        json!({"initialBundleSha256":"f".repeat(64)}),
        json!({"generation":0}),
        json!({"revision":"other"}),
        json!({"acceptedSequence":"1"}),
        json!({"pending":true}),
        json!({"opened":false}),
        json!({"reloadRequired":true}),
    ] {
        let (config, server) = setup(move |listener| {
            let mut state = status("initial", 0, false);
            for (key, value) in replacement.as_object().unwrap() {
                state[key] = value.clone();
            }
            drop(handshake(&listener, state));
        });
        assert!(Client::connect(config).is_err());
        server.join().unwrap();
    }
}
#[test]
fn invalid_terminal_never_advances_or_retries() {
    for replacement in [
        json!({"generation":8}),
        json!({"sequence":"2"}),
        json!({"baseRevision":"other"}),
        json!({"targetRevision":"other"}),
        json!({"payloadSha256":"f".repeat(64)}),
        json!({"phase":"evaluate"}),
        json!({"appliedRevision":"initial"}),
        json!({"reloadRequired":true}),
    ] {
        let (config, server) = setup(move |listener| {
            let mut stream = handshake(&listener, status("initial", 0, false));
            let p = receive(&mut stream).unwrap();
            respond(&mut stream, ack(&p, "queued"));
            receive(&mut stream).unwrap();
            let mut terminal = ack(&p, "applied");
            for (key, value) in replacement.as_object().unwrap() {
                terminal[key] = value.clone();
            }
            respond(&mut stream, terminal);
        });
        let mut client = Client::connect(config).unwrap();
        assert!(client.patch(patch(1, "initial", "next")).is_err());
        assert_eq!(client.ready()["sequence"], "1");
        assert_eq!(client.ready()["revision"], "initial");
        drop(client);
        server.join().unwrap();
    }
}
#[test]
fn poison_terminal_stops_without_advancing() {
    let (config, server) = setup(|listener| {
        let mut stream = handshake(&listener, status("initial", 0, false));
        complete(&mut stream, "1", "reload-required");
    });
    let mut client = Client::connect(config).unwrap();
    assert_eq!(
        client.patch(patch(1, "initial", "next")).unwrap()["result"]["status"],
        "reload-required"
    );
    assert!(client.stopped());
    assert!(client.patch(patch(1, "initial", "next")).is_err());
    drop(client);
    server.join().unwrap();
}
#[test]
fn malformed_frames_fatal_before_body_allocation() {
    for bytes in [
        0u32.to_be_bytes().to_vec(),
        ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec(),
        vec![0, 0, 0, 1, b'{'],
    ] {
        let (config, server) = setup(move |listener| {
            let (mut stream, _) = listener.accept().unwrap();
            receive(&mut stream).unwrap();
            stream.write_all(&bytes).unwrap();
        });
        assert!(matches!(Client::connect(config), Err(Error::Invalid(_))));
        server.join().unwrap();
    }
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "nh-dev-transport-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn bounded_private_config_and_payload_files() {
    let temp = Temp::new();
    let path = temp.0.join("config.json");
    let value = json!({"schemaVersion":1,"host":"127.0.0.1","port":1234,"token":"a".repeat(64),"sessionId":"b".repeat(32),"initialRevision":"initial","initialBundleSha256":"c".repeat(64)});
    std::fs::write(&path, value.to_string()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(Config::read(&path).is_ok());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Config::read(&path).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = temp.0.join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(Config::read(&link).is_err());
    let mut bad = value.clone();
    bad["host"] = json!("192.0.2.1");
    std::fs::write(&path, bad.to_string()).unwrap();
    assert!(Config::read(&path).is_err());
    std::fs::write(&path, vec![b'x'; MAX_CONTROL + 1]).unwrap();
    assert!(Config::read(&path).is_err());
    let source = temp.0.join("patch.js");
    let p = json!({"method":"patch","sequence":"1","baseRevision":"initial","targetRevision":"next","payloadSha256":"d".repeat(64),"payloadFile":source});
    for bytes in [vec![], vec![0], vec![255], vec![b'x'; MAX_SOURCE + 1]] {
        std::fs::write(&source, bytes).unwrap();
        assert!(Patch::read(&p).is_err());
    }
    std::fs::write(&source, b"({status:'applied'})").unwrap();
    assert!(Patch::read(&p).is_ok());
    let mut relative = p.clone();
    relative["payloadFile"] = json!("relative.js");
    assert!(Patch::read(&relative).is_err());
    let mut cursor = io::Cursor::new(vec![b'x'; MAX_CONTROL + 1]);
    assert!(read_control(&mut cursor).is_err());
    assert!(read_control(&mut io::Cursor::new(Vec::<u8>::new()))
        .unwrap()
        .is_none());
    assert!(is_quit(
        &read_control(&mut io::Cursor::new(b"{\"method\":\"quit\"}\n"))
            .unwrap()
            .unwrap()
    )
    .unwrap());
}
