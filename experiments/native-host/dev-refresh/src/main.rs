use native_host_refresh_transport::{is_quit, read_control, Client, Config, Error, Patch, Result};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::PathBuf;
fn emit(value: &Value) -> Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, value)
        .map_err(|_| Error::Invalid("cannot encode output"))?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--help" {
        println!("native-host-refresh-transport --config /absolute/private-config.json\nOrdered loopback development client. Read bounded patch/quit JSON lines from stdin.");
        return Ok(());
    }
    if args.len() != 2 || args[0] != "--config" {
        return Err(Error::Invalid(
            "usage: native-host-refresh-transport --config path",
        ));
    }
    let config = Config::read(&PathBuf::from(&args[1]))?;
    let mut client = Client::connect(config)?;
    emit(&client.ready())?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    while let Some(value) = read_control(&mut input)? {
        if is_quit(&value)? {
            break;
        }
        emit(&client.patch(Patch::read(&value)?)?)?;
        if client.stopped() {
            return Err(Error::Invalid(
                "native update poisoned; explicit full reload required",
            ));
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        let _ = emit(&json!({"event":"fatal","message":error.to_string()}));
        std::process::exit(1);
    }
}
