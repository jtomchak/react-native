//! Ordered desktop development transport. Never linked into a mobile runtime.
use serde_json::{json, Map, Value};
use std::fs::OpenOptions;
use std::io::{self, BufRead, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const MAX_FRAME: usize = 8 * 1024 * 1024 + 16384;
pub const MAX_SOURCE: usize = 4 * 1024 * 1024;
pub const MAX_CONTROL: usize = 16384;
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Invalid(&'static str),
    Native(&'static str),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // No request/config/remote body is included: authentication stays private.
        match self {
            Self::Io(error) => write!(f, "transport I/O: {}", error.kind()),
            Self::Invalid(message) | Self::Native(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
pub type Result<T> = std::result::Result<T, Error>;
fn require(value: bool, message: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(Error::Invalid(message))
    }
}
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or(Error::Invalid("JSON object required"))
}
fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("required string field missing"))
}
fn uint(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(Error::Invalid("required unsigned integer field missing"))
}
fn boolean(value: &Value, field: &str) -> Result<bool> {
    value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or(Error::Invalid("required boolean field missing"))
}
fn keys(value: &Value, expected: &[&str]) -> Result<()> {
    let map = object(value)?;
    require(
        map.len() == expected.len() && map.keys().all(|key| expected.contains(&key.as_str())),
        "unexpected or missing fields",
    )
}
fn decimal(value: &str, allow_zero: bool) -> Result<u64> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| Error::Invalid("invalid decimal u64"))?;
    require(
        parsed.to_string() == value && (allow_zero || parsed != 0),
        "noncanonical decimal u64",
    )?;
    Ok(parsed)
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn revision(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        result.push(DIGITS[usize::from(b >> 4)] as char);
        result.push(DIGITS[usize::from(b & 15)] as char);
    }
    result
}
fn read_regular(path: &Path, limit: usize, private: bool) -> Result<Vec<u8>> {
    require(
        std::fs::symlink_metadata(path)?.file_type().is_file(),
        "regular nonsymlink file required",
    )?;
    let mut options = OpenOptions::new();
    options.read(true);
    // O_NOFOLLOW closes the final-component symlink race. O_NONBLOCK avoids
    // blocking if a regular file is raced into a FIFO; fstat validates the inode.
    #[cfg(target_os = "macos")]
    options.custom_flags(0x100 | 0x4);
    #[cfg(target_os = "linux")]
    options.custom_flags(0x20000 | 0x800);
    let file = options.open(path)?;
    let before = file.metadata()?;
    require(
        before.is_file() && before.len() <= limit as u64,
        "regular bounded file required",
    )?;
    if private {
        #[cfg(unix)]
        require(
            before.permissions().mode() & 0o7777 == 0o600,
            "configuration permissions must be 0600",
        )?;
        #[cfg(not(unix))]
        return Err(Error::Invalid(
            "private configuration permission verification requires Unix",
        ));
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
    require(bytes.len() <= limit, "file exceeds limit")?;
    let after = file.metadata()?;
    require(
        before.len() == after.len() && before.modified()? == after.modified()?,
        "file changed while reading",
    )?;
    #[cfg(unix)]
    require(
        before.ctime() == after.ctime() && before.ctime_nsec() == after.ctime_nsec(),
        "file changed while reading",
    )?;
    Ok(bytes)
}

pub struct Config {
    port: u16,
    token: String,
    session: String,
    initial_revision: String,
    initial_hash: String,
}
impl Config {
    pub fn read(path: &Path) -> Result<Self> {
        let value: Value = serde_json::from_slice(&read_regular(path, MAX_CONTROL, true)?)
            .map_err(|_| Error::Invalid("invalid configuration JSON"))?;
        keys(
            &value,
            &[
                "schemaVersion",
                "host",
                "port",
                "token",
                "sessionId",
                "initialRevision",
                "initialBundleSha256",
            ],
        )?;
        require(
            uint(&value, "schemaVersion")? == 1 && string(&value, "host")? == "127.0.0.1",
            "unsupported configuration or non-loopback host",
        )?;
        let port =
            u16::try_from(uint(&value, "port")?).map_err(|_| Error::Invalid("invalid port"))?;
        require(port != 0, "explicit forwarded port required")?;
        let token = string(&value, "token")?.to_owned();
        let session = string(&value, "sessionId")?.to_owned();
        let initial_revision = string(&value, "initialRevision")?.to_owned();
        let initial_hash = string(&value, "initialBundleSha256")?.to_owned();
        require(
            hex(&token, 64)
                && hex(&session, 32)
                && session.bytes().any(|b| b != b'0')
                && hex(&initial_hash, 64)
                && revision(&initial_revision),
            "invalid configuration identity",
        )?;
        Ok(Self {
            port,
            token,
            session,
            initial_revision,
            initial_hash,
        })
    }
}

pub struct Patch {
    sequence: u64,
    base: String,
    target: String,
    hash: String,
    source: Vec<u8>,
}
impl Patch {
    pub fn read(value: &Value) -> Result<Self> {
        keys(
            value,
            &[
                "method",
                "sequence",
                "baseRevision",
                "targetRevision",
                "payloadSha256",
                "payloadFile",
            ],
        )?;
        require(
            string(value, "method")? == "patch",
            "unknown control method",
        )?;
        let sequence = decimal(string(value, "sequence")?, false)?;
        let base = string(value, "baseRevision")?.to_owned();
        let target = string(value, "targetRevision")?.to_owned();
        let hash = string(value, "payloadSha256")?.to_owned();
        require(
            revision(&base) && revision(&target) && base != target && hex(&hash, 64),
            "invalid patch identity",
        )?;
        let file = PathBuf::from(string(value, "payloadFile")?);
        require(
            file.is_absolute(),
            "absolute immutable payload file required",
        )?;
        let source = read_regular(&file, MAX_SOURCE, false)?;
        require(
            !source.is_empty() && !source.contains(&0) && std::str::from_utf8(&source).is_ok(),
            "nonempty UTF-8 script without NUL required",
        )?;
        Ok(Self {
            sequence,
            base,
            target,
            hash,
            source,
        })
    }
    fn envelope(&self, generation: u64, session: &str) -> Value {
        json!({"method":"dev.enqueue","generation":generation.to_string(),"sessionId":session,
            "sequence":self.sequence.to_string(),"baseRevision":self.base,"targetRevision":self.target,
            "payloadSha256":self.hash,"payloadHex":encode_hex(&self.source)})
    }
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(|| Error::Io(io::Error::new(io::ErrorKind::TimedOut, "frame deadline")))
}
fn write_all(stream: &mut TcpStream, mut bytes: &[u8], deadline: Instant) -> Result<()> {
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        match stream.write(bytes) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "frame write").into()),
            Ok(n) => bytes = &bytes[n..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn read_exact(stream: &mut TcpStream, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
    while !bytes.is_empty() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        match stream.read(bytes) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "frame read").into()),
            Ok(n) => bytes = &mut bytes[n..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn send(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Invalid("cannot encode frame"))?;
    require(
        !bytes.is_empty() && bytes.len() <= MAX_FRAME,
        "outgoing frame exceeds limit",
    )?;
    let deadline = Instant::now() + TIMEOUT;
    write_all(stream, &(bytes.len() as u32).to_be_bytes(), deadline)?;
    write_all(stream, &bytes, deadline)
}
fn receive(stream: &mut TcpStream) -> Result<Value> {
    let deadline = Instant::now() + TIMEOUT;
    let mut header = [0; 4];
    read_exact(stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    require(
        length > 0 && length <= MAX_FRAME,
        "invalid incoming frame size",
    )?;
    let mut bytes = vec![0; length];
    read_exact(stream, &mut bytes, deadline)?;
    let value =
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid incoming JSON"))?;
    object(&value)?;
    Ok(value)
}
fn result(value: Value) -> Result<Value> {
    require(
        value.get("id") == Some(&Value::Null),
        "native response must have id:null",
    )?;
    if value.get("error").is_some() {
        return Err(Error::Native(
            "native request rejected; explicit recovery required",
        ));
    }
    let result = value
        .get("result")
        .cloned()
        .ok_or(Error::Invalid("native result missing"))?;
    object(&result)?;
    Ok(result)
}
fn call(stream: &mut TcpStream, request: &Value) -> Result<Value> {
    send(stream, request)?;
    result(receive(stream)?)
}
fn connect(config: &Config) -> Result<TcpStream> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port);
    let mut stream = TcpStream::connect_timeout(&address, TIMEOUT)?;
    stream.set_nodelay(true)?;
    let auth = call(
        &mut stream,
        &json!({"method":"authenticate","token":config.token}),
    )?;
    require(
        boolean(&auth, "authenticated")?,
        "authentication was not accepted",
    )?;
    Ok(stream)
}

pub struct Client {
    config: Config,
    stream: TcpStream,
    generation: u64,
    revision: String,
    next: u64,
    stopped: bool,
}
impl Client {
    pub fn connect(config: Config) -> Result<Self> {
        let mut stream = connect(&config)?;
        let status = call(&mut stream, &json!({"method":"dev.status"}))?;
        let generation = uint(&status, "generation")?;
        Self::identity(&config, generation, &status)?;
        require(
            !boolean(&status, "pending")?
                && !boolean(&status, "reloadRequired")?
                && decimal(string(&status, "acceptedSequence")?, true)? == 0
                && string(&status, "revision")? == config.initial_revision,
            "new process refuses unknown native update history; explicit reload required",
        )?;
        let revision = config.initial_revision.clone();
        Ok(Self {
            config,
            stream,
            generation,
            revision,
            next: 1,
            stopped: false,
        })
    }
    fn identity(config: &Config, generation: u64, status: &Value) -> Result<()> {
        require(
            uint(status, "version")? == 1
                && uint(status, "generation")? == generation
                && generation > 0
                && boolean(status, "enabled")?
                && boolean(status, "opened")?
                && string(status, "sessionId")? == config.session
                && string(status, "initialBundleSha256")? == config.initial_hash,
            "native session/generation/initial bundle identity mismatch",
        )
    }
    pub fn ready(&self) -> Value {
        json!({"event":"ready","generation":self.generation,"revision":self.revision,"sequence":self.next.to_string()})
    }
    fn resume(&mut self, patch: &Patch) -> Result<()> {
        let mut stream = connect(&self.config)?;
        let status = call(&mut stream, &json!({"method":"dev.status"}))?;
        Self::identity(&self.config, self.generation, &status)?;
        require(
            !boolean(&status, "reloadRequired")?,
            "native session requires full reload after lost acknowledgement",
        )?;
        let accepted = decimal(string(&status, "acceptedSequence")?, true)?;
        let current = string(&status, "revision")?;
        let pending = boolean(&status, "pending")?;
        let compatible = if pending {
            accepted == patch.sequence && current == patch.base
        } else {
            (accepted == patch.sequence - 1 && current == patch.base)
                || (accepted == patch.sequence
                    && (current == patch.base || current == patch.target))
        };
        require(
            compatible,
            "reconnect history is incompatible; no patch retry",
        )?;
        let _ = self.stream.shutdown(Shutdown::Both);
        self.stream = stream;
        Ok(())
    }
    fn attempt(&mut self, patch: &Patch, envelope: &Value) -> Result<Value> {
        let response = call(&mut self.stream, envelope)?;
        if string(&response, "status")? != "queued" {
            return Self::terminal(self.generation, patch, response);
        }
        Self::patch_identity(patch, &response)?;
        let terminal = call(&mut self.stream, &json!({"method":"dev.drain"}))?;
        Self::terminal(self.generation, patch, terminal)
    }
    fn patch_identity(patch: &Patch, value: &Value) -> Result<()> {
        require(
            decimal(string(value, "sequence")?, false)? == patch.sequence
                && string(value, "baseRevision")? == patch.base
                && string(value, "targetRevision")? == patch.target
                && string(value, "payloadSha256")? == patch.hash,
            "patch acknowledgement identity mismatch",
        )
    }
    fn terminal(generation: u64, patch: &Patch, value: Value) -> Result<Value> {
        Self::patch_identity(patch, &value)?;
        require(
            uint(&value, "generation")? == generation,
            "terminal generation mismatch",
        )?;
        let status = string(&value, "status")?;
        let phase = string(&value, "phase")?;
        let poisoned = boolean(&value, "reloadRequired")?;
        let applied = string(&value, "appliedRevision")?;
        require(
            match status {
                "applied" => !poisoned && phase == "mount-submitted" && applied == patch.target,
                "rejected" => !poisoned && phase == "prepare" && applied == patch.base,
                "reload-required" => {
                    poisoned
                        && ["evaluate", "microtasks", "mount"].contains(&phase)
                        && applied == patch.base
                }
                _ => false,
            },
            "inconsistent terminal acknowledgement",
        )?;
        Ok(value)
    }
    pub fn patch(&mut self, patch: Patch) -> Result<Value> {
        require(
            !self.stopped,
            "transport stopped; explicit recovery required",
        )?;
        // No network or queue side effects before local ordering checks.
        require(
            patch.sequence == self.next && patch.base == self.revision && self.next < u64::MAX,
            "out-of-order patch or wrong base; no coalescing permitted",
        )?;
        let envelope = patch.envelope(self.generation, &self.config.session);
        let first = self.attempt(&patch, &envelope);
        let terminal = match first {
            Err(Error::Io(_)) => {
                // One reconnect only, then resend the exact immutable envelope.
                self.resume(&patch)
                    .and_then(|()| self.attempt(&patch, &envelope))
            }
            other => other,
        };
        let terminal = match terminal {
            Ok(value) => value,
            Err(error) => {
                self.stopped = true;
                return Err(error);
            }
        };
        match string(&terminal, "status")? {
            "applied" => {
                self.revision = patch.target;
                self.next += 1;
            }
            "rejected" => self.next += 1,
            "reload-required" => self.stopped = true,
            _ => unreachable!(),
        }
        Ok(json!({"event":"patch.terminal","result":terminal}))
    }
    pub fn stopped(&self) -> bool {
        self.stopped
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

pub fn read_control(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }
        let end = buffer.iter().position(|b| *b == b'\n');
        let length = end.map_or(buffer.len(), |index| index + 1);
        require(
            line.len() + length <= MAX_CONTROL,
            "control line exceeds 16 KiB",
        )?;
        line.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if end.is_some() {
            break;
        }
    }
    let value =
        serde_json::from_slice(&line).map_err(|_| Error::Invalid("invalid control JSON"))?;
    object(&value)?;
    Ok(Some(value))
}
pub fn is_quit(value: &Value) -> Result<bool> {
    if string(value, "method")? != "quit" {
        return Ok(false);
    }
    keys(value, &["method"])?;
    Ok(true)
}

#[cfg(test)]
mod tests;
