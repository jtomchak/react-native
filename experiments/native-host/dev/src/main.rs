//! Development supervisor. Rolldown owns the JS dependency graph; this process
//! owns lifecycle, immutable revision handoff, deployment order and timing.
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

static STOP: AtomicBool = AtomicBool::new(false);
const MAX_LINE: usize = 4096;

#[cfg(unix)]
extern "C" {
    fn signal(number: i32, handler: extern "C" fn(i32)) -> usize;
    fn kill(pid: i32, signal: i32) -> i32;
}

extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::Relaxed);
}

fn quoted(value: &str) -> String {
    let mut result = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            c if c < ' ' => result.push_str(&format!("\\u{:04x}", c as u32)),
            c => result.push(c),
        }
    }
    result.push('"');
    result
}

fn report(event: &str, extra: &str) {
    if writeln!(
        io::stdout().lock(),
        "{{\"event\":{}{extra}}}",
        quoted(event)
    )
    .is_err()
    {
        STOP.store(true, Ordering::Relaxed);
    }
}

fn take_change_time(changes: &mut BTreeMap<u64, Instant>, covered: u64) -> Option<Instant> {
    let first = changes.range(..=covered).next().map(|(_, start)| *start);
    changes.retain(|sequence, _| *sequence > covered);
    first
}

struct Options {
    root: PathBuf,
    watch_script: PathBuf,
    entry: String,
    node: String,
    build_delay: String,
    deploy_command: Option<String>,
    deploy_args: Vec<String>,
}

fn options() -> Result<Option<Options>, String> {
    let default_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut options = Options {
        root: default_root.clone(),
        watch_script: default_root.join("scripts/watch.mjs"),
        entry: "js/entry.jsx".into(),
        node: "node".into(),
        build_delay: "35".into(),
        deploy_command: None,
        deploy_args: Vec::new(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(option) = args.next() {
        if option == "--help" {
            println!("native-host-dev [--root PATH] [--entry js/entry.jsx] [--build-delay MS]\n  [--node PATH] [--watch-script PATH]\n  [--deploy-command EXECUTABLE [--deploy-arg ARG]...]\n\nWatches and publishes immutable bundles. No native builds or platform actions\nwithout --deploy-command. Deployment receives the revision directory as its\nlast argument and NH_DEV_REVISION/NH_DEV_REVISION_DIR environment variables.\nReload is full restart, not HMR. Type quit or send SIGINT/SIGTERM to shut down.\nstdout contains JSON event records; diagnostics go to stderr.");
            return Ok(None);
        }
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {option}"))?;
        match option.as_str() {
            "--root" => options.root = value.into(),
            "--watch-script" => options.watch_script = value.into(),
            "--entry" => options.entry = value,
            "--node" => options.node = value,
            "--build-delay" => {
                let delay: u32 = value.parse().map_err(|_| "Invalid build delay")?;
                if delay > 10000 {
                    return Err("Build delay must be <=10000ms".into());
                }
                options.build_delay = value;
            }
            "--deploy-command" => options.deploy_command = Some(value),
            "--deploy-arg" => options.deploy_args.push(value),
            _ => return Err(format!("Unknown option: {option}")),
        }
    }
    if options.deploy_command.is_none() && !options.deploy_args.is_empty() {
        return Err("--deploy-arg requires --deploy-command".into());
    }
    options.root = fs::canonicalize(&options.root).map_err(|e| format!("Root: {e}"))?;
    options.watch_script =
        fs::canonicalize(&options.watch_script).map_err(|e| format!("Watcher: {e}"))?;
    Ok(Some(options))
}

#[derive(Debug)]
struct Revision {
    id: String,
    sha256: String,
    bytes: u64,
    bundle_ms: f64,
    change: u64,
}

#[derive(Debug)]
enum Event {
    Ready(u32, String),
    Change(u64),
    BuildStart(u64),
    Bundle(Revision),
    Error(u64, u64),
    Stopped,
}

fn unsigned(value: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Non-numeric protocol field".into());
    }
    value
        .parse()
        .map_err(|_| "Protocol integer overflow".into())
}

fn parse(line: &str) -> Result<Event, String> {
    if line.len() > MAX_LINE {
        return Err("Oversized watcher frame".into());
    }
    let fields: Vec<&str> = line.trim_end_matches('\n').split('\t').collect();
    match fields.as_slice() {
        ["READY", pid, version]
            if version.len() <= 64
                && version
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)) =>
        {
            Ok(Event::Ready(
                unsigned(pid)?.try_into().map_err(|_| "Invalid PID")?,
                version.to_string(),
            ))
        }
        ["CHANGE", sequence] => Ok(Event::Change(unsigned(sequence)?)),
        ["BUILD_START", sequence] => Ok(Event::BuildStart(unsigned(sequence)?)),
        ["ERROR", sequence, change] => Ok(Event::Error(unsigned(sequence)?, unsigned(change)?)),
        ["STOPPED"] => Ok(Event::Stopped),
        ["BUNDLE", revision, sha, bytes, duration, change] => {
            if revision.is_empty()
                || revision.len() > 64
                || !revision.bytes().all(|c| c.is_ascii_digit())
            {
                return Err("Invalid revision identifier".into());
            }
            if sha.len() != 64
                || !sha
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("Invalid SHA256".into());
            }
            let bundle_ms: f64 = duration.parse().map_err(|_| "Invalid duration")?;
            if !bundle_ms.is_finite() || !(0.0..=3600000.0).contains(&bundle_ms) {
                return Err("Invalid duration range".into());
            }
            let bytes = unsigned(bytes)?;
            if bytes == 0 || bytes > 128 * 1024 * 1024 {
                return Err("Invalid artifact size".into());
            }
            Ok(Event::Bundle(Revision {
                id: revision.to_string(),
                sha256: sha.to_string(),
                bytes,
                bundle_ms,
                change: unsigned(change)?,
            }))
        }
        _ => Err("Invalid watcher protocol frame".into()),
    }
}

fn spawn_watcher(options: &Options) -> Result<(Child, Receiver<Result<Event, String>>), String> {
    let mut command = Command::new(&options.node);
    command
        .arg(&options.watch_script)
        .args(["--root"])
        .arg(&options.root)
        .args([
            "--entry",
            &options.entry,
            "--build-delay",
            &options.build_delay,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start watcher: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing watcher output")?;
    let (tx, rx) = mpsc::sync_channel(64);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut bytes = Vec::with_capacity(256);
            let read = reader
                .by_ref()
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut bytes);
            let event = match read {
                Ok(0) => return,
                Ok(_) if bytes.len() > MAX_LINE || !bytes.ends_with(b"\n") => {
                    Err("Oversized or unterminated watcher frame".into())
                }
                Ok(_) => std::str::from_utf8(&bytes)
                    .map_err(|_| "Invalid watcher UTF-8".into())
                    .and_then(parse),
                Err(e) => Err(format!("Watcher read failed: {e}")),
            };
            let bad = event.is_err();
            if tx.send(event).is_err() || bad {
                return;
            }
        }
    });
    Ok((child, rx))
}

fn stop_child(child: &mut Child, graceful: bool) {
    if graceful {
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(b"quit\n");
        }
    } else {
        #[cfg(unix)]
        unsafe {
            kill(-(child.id() as i32), 15);
        }
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            // A shell/adapter may exit on SIGTERM before its own children do.
            // Reap the complete group even after the direct child exits.
            #[cfg(unix)]
            unsafe {
                kill(-(child.id() as i32), 9);
            }
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    #[cfg(unix)]
    unsafe {
        kill(-(child.id() as i32), 9);
    }
    let _ = child.kill();
    let _ = child.wait();
}

struct Deployment {
    child: Child,
    revision: String,
    started: Instant,
}

fn deploy(options: &Options, revision: Revision) -> Result<Deployment, String> {
    let directory = options.root.join("build/revisions").join(&revision.id);
    let log_directory = options.root.join("build/dev-logs");
    fs::create_dir_all(&log_directory).map_err(|e| format!("Deployment logs: {e}"))?;
    let log_path = log_directory.join(format!("{}.log", revision.id));
    let log = File::create(&log_path).map_err(|e| format!("Deployment log: {e}"))?;
    let mut command = Command::new(
        options
            .deploy_command
            .as_ref()
            .ok_or("No deployment command")?,
    );
    command
        .args(&options.deploy_args)
        .arg(&directory)
        .env("NH_DEV_REVISION", &revision.id)
        .env("NH_DEV_REVISION_DIR", &directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|e| format!("Deployment spawn failed: {e}"))?;
    report(
        "deploy.started",
        &format!(
            ",\"revision\":{},\"pid\":{},\"log\":{}",
            quoted(&revision.id),
            child.id(),
            quoted(&log_path.to_string_lossy())
        ),
    );
    Ok(Deployment {
        child,
        revision: revision.id,
        started: Instant::now(),
    })
}

fn run(options: Options) -> Result<(), String> {
    #[cfg(unix)]
    unsafe {
        signal(2, stop_signal);
        signal(15, stop_signal);
    }
    thread::spawn(|| {
        let mut reader = io::stdin().lock();
        loop {
            let mut input = String::new();
            match reader.by_ref().take(MAX_LINE as u64).read_line(&mut input) {
                Ok(0) | Err(_) => return,
                Ok(_) if input.trim() == "quit" => {
                    STOP.store(true, Ordering::Relaxed);
                    return;
                }
                _ => {}
            }
        }
    });
    let (mut watcher, rx) = spawn_watcher(&options)?;
    report(
        "supervisor.started",
        &format!(
            ",\"watcherPid\":{},\"reload\":\"full\",\"nativeBuild\":false",
            watcher.id()
        ),
    );
    let mut pending = None;
    let mut active: Option<Deployment> = None;
    let mut changes = BTreeMap::new();
    let mut latest_change = 0;
    let mut failure = None;
    while !STOP.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(Event::Ready(pid, version))) => report(
                "watcher.ready",
                &format!(",\"pid\":{pid},\"rolldown\":{}", quoted(&version)),
            ),
            Ok(Ok(Event::Change(sequence))) => {
                if sequence <= latest_change {
                    failure = Some("Non-monotonic change sequence".into());
                    break;
                }
                latest_change = sequence;
                if changes.len() >= 4096 {
                    failure = Some("Too many unacknowledged changes".into());
                    break;
                }
                changes.insert(sequence, Instant::now());
                report("source.changed", &format!(",\"sequence\":{sequence}"));
            }
            Ok(Ok(Event::BuildStart(sequence))) => {
                report("bundle.started", &format!(",\"build\":{sequence}"))
            }
            Ok(Ok(Event::Error(sequence, change))) => {
                // Keep last-good immutable artifacts intact. Recovery is a
                // later build, not a successful retry counted as this build.
                report("bundle.failed", &format!(",\"build\":{sequence}"));
                changes.retain(|sequence, _| *sequence > change);
            }
            Ok(Ok(Event::Bundle(revision))) => {
                let directory = options.root.join("build/revisions").join(&revision.id);
                let valid = revision.change <= latest_change
                    && fs::metadata(directory.join("app.bundle.js"))
                        .map(|m| m.len() == revision.bytes)
                        .unwrap_or(false)
                    && directory.join("app.bundle.js.map").is_file()
                    && directory.join("manifest.json").is_file();
                if !valid {
                    failure = Some("Incomplete or inconsistent published revision".into());
                    break;
                }
                let first_change = take_change_time(&mut changes, revision.change);
                let elapsed = first_change
                    .map(|start| format!("{:.3}", start.elapsed().as_secs_f64() * 1000.0))
                    .unwrap_or_else(|| "null".into());
                report("revision.ready", &format!(",\"revision\":{},\"sha256\":{},\"byteLength\":{},\"bundleMs\":{},\"watcherEventToBundleMs\":{},\"directory\":{}", quoted(&revision.id), quoted(&revision.sha256), revision.bytes, revision.bundle_ms, elapsed, quoted(&directory.to_string_lossy())));
                if options.deploy_command.is_some() {
                    if let Some(skipped) = pending.replace(revision) {
                        report(
                            "deploy.coalesced",
                            &format!(",\"revision\":{}", quoted(&skipped.id)),
                        );
                    }
                }
            }
            Ok(Ok(Event::Stopped)) => {
                failure = Some("Watcher stopped unexpectedly".into());
                break;
            }
            Ok(Err(error)) => {
                failure = Some(error);
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                failure = Some("Watcher exited unexpectedly".into());
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some(deployment) = active.as_mut() {
            match deployment.child.try_wait() {
                Ok(Some(status)) => {
                    let event = if status.success() {
                        "deploy.completed"
                    } else {
                        "deploy.failed"
                    };
                    report(
                        event,
                        &format!(
                            ",\"revision\":{},\"elapsedMs\":{:.3},\"exitCode\":{}",
                            quoted(&deployment.revision),
                            deployment.started.elapsed().as_secs_f64() * 1000.0,
                            status.code().map_or("null".into(), |n| n.to_string())
                        ),
                    );
                    active = None;
                }
                Err(error) => {
                    failure = Some(format!("Deployment wait failed: {error}"));
                    break;
                }
                Ok(None) => {}
            }
        }
        if active.is_none() {
            if let Some(revision) = pending.take() {
                match deploy(&options, revision) {
                    Ok(deployment) => active = Some(deployment),
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
        }
    }
    // Dropping rx first releases a protocol reader blocked on a full queue.
    drop(rx);
    if let Some(mut deployment) = active {
        stop_child(&mut deployment.child, false);
    }
    stop_child(&mut watcher, true);
    report("supervisor.stopped", "");
    if let Some(error) = failure {
        Err(error)
    } else {
        Ok(())
    }
}

fn main() {
    let result = options().and_then(|options| options.map(run).transpose().map(|_| ()));
    if let Err(error) = result {
        eprintln!("native-host-dev: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_protocol() {
        assert!(matches!(
            parse("READY\t123\t1.3.0\n"),
            Ok(Event::Ready(123, _))
        ));
        assert!(matches!(parse("CHANGE\t2\n"), Ok(Event::Change(2))));
        let frame = format!("BUNDLE\t123456789\t{}\t45\t12.5\t2\n", "a".repeat(64));
        assert!(matches!(parse(&frame), Ok(Event::Bundle(_))));
    }

    #[test]
    fn rejects_paths_oversize_and_invalid_scalars() {
        for revision in ["../escape", "12/3", "", "12\n3"] {
            assert!(parse(&format!(
                "BUNDLE\t{revision}\t{}\t4\t1\t0\n",
                "a".repeat(64)
            ))
            .is_err());
        }
        assert!(parse(&"x".repeat(MAX_LINE + 1)).is_err());
        for duration in ["NaN", "inf", "-1", "3600001"] {
            assert!(parse(&format!(
                "BUNDLE\t123\t{}\t4\t{duration}\t0\n",
                "a".repeat(64)
            ))
            .is_err());
        }
        assert!(parse("CHANGE\t18446744073709551616\n").is_err());
        assert!(parse("CHANGE\t1\textra\n").is_err());
    }

    #[test]
    fn json_output_escapes_control_characters() {
        assert_eq!(quoted("a\"b\\c\nd"), "\"a\\\"b\\\\c\\u000ad\"");
    }

    #[test]
    fn publishing_a_build_does_not_consume_changes_observed_during_that_build() {
        let first = Instant::now();
        let second = first + Duration::from_millis(1);
        let mut changes = BTreeMap::from([(1, first), (2, second)]);
        assert_eq!(take_change_time(&mut changes, 1), Some(first));
        assert_eq!(changes.len(), 1);
        assert_eq!(take_change_time(&mut changes, 1), None);
        assert_eq!(take_change_time(&mut changes, 2), Some(second));
        assert!(changes.is_empty());
    }
}
