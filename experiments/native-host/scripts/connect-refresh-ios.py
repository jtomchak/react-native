#!/usr/bin/env python3
"""Stage a verified Refresh bootstrap and opt in a private iOS development session.

The simulator uses shared loopback; physical support is added through an explicit
device selector. No authentication token is printed or placed in argv.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "dev.nativehost.prototype"


class ConnectorInterrupted(BaseException):
    """Distinct from InterruptedError, which Python selectors may retry."""


def call(arguments, timeout=30, env=None, check=True):
    child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, env=env)
    try:
        stdout, stderr = child.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
        raise
    if check and child.returncode:
        raise subprocess.CalledProcessError(child.returncode, arguments, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(arguments, child.returncode, stdout, stderr)


def private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > 16384 or info.st_mode & 0o077:
            raise ValueError("Expected a bounded regular private JSON file")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            data = source.read(16385)
        if len(data) != info.st_size:
            raise ValueError("Private JSON changed while reading")
        return json.loads(data)
    finally:
        os.close(descriptor)


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".refresh-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


def configuration(args):
    if args.session is None or args.revision_directory is None:
        raise ValueError("--session and --revision-directory are required")
    config = private_json(args.session)
    if set(config) != {"schemaVersion", "token", "sessionId", "initialRevision", "initialBundleSha256", "port"} or type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1:
        raise ValueError("Invalid development configuration schema")
    for name, length in [("token", 64), ("sessionId", 32), ("initialBundleSha256", 64)]:
        if not isinstance(config[name], str) or not re.fullmatch(f"[a-f0-9]{{{length}}}", config[name]):
            raise ValueError(f"Invalid {name}")
    if type(config["port"]) is not int or not (config["port"] == 0 or 1024 <= config["port"] <= 65535):
        raise ValueError("Invalid development port")
    directory = args.revision_directory.resolve(strict=True)
    if not re.fullmatch("[0-9]{1,64}", directory.name) or config["initialRevision"] != directory.name:
        raise ValueError("Initial revision mismatch")
    manifest_file = directory / "manifest.json"
    if not manifest_file.is_file() or manifest_file.is_symlink() or manifest_file.stat().st_size > 65536:
        raise ValueError("Invalid initial manifest")
    manifest = json.loads(manifest_file.read_bytes())
    if manifest.get("schemaVersion") != 1 or manifest.get("mode") != "development" or manifest.get("reload") != "full" or manifest.get("revision") != directory.name or manifest.get("sha256") != config["initialBundleSha256"]:
        raise ValueError("Initial manifest mismatch")
    for name, metadata in [("app.bundle.js", manifest), ("app.bundle.js.map", manifest.get("sourceMap", {}))]:
        file = directory / name
        if not file.is_file() or file.is_symlink() or not 0 < file.stat().st_size <= 8 * 1024 * 1024:
            raise ValueError("Invalid initial artifact")
        content = file.read_bytes()
        if type(metadata.get("byteLength")) is not int or len(content) != metadata["byteLength"] or hashlib.sha256(content).hexdigest() != metadata.get("sha256"):
            raise ValueError("Initial artifact integrity mismatch")
    if manifest["sourceMap"].get("file") != "app.bundle.js.map":
        raise ValueError("Invalid initial source map")
    return config, directory


def stop_forward(owner):
    pid = owner["forwardPid"]
    if type(pid) is not int or pid <= 1:
        raise ValueError("Invalid forward process identity")
    result = call(["/bin/ps", "-p", str(pid), "-o", "lstart=", "-o", "command="], check=False)
    if result.returncode:
        return
    if result.stdout.decode().strip() != owner["forwardIdentity"]:
        raise ValueError("Forward PID was reused; refusing to stop it")
    os.killpg(pid, signal.SIGTERM)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = call(["/bin/ps", "-p", str(pid), "-o", "stat="], check=False)
        if result.returncode or result.stdout.decode().strip().startswith("Z"):
            return
        time.sleep(0.05)
    # Recheck identity before escalating an owned process.
    result = call(["/bin/ps", "-p", str(pid), "-o", "lstart=", "-o", "command="], check=False)
    if result.returncode == 0 and result.stdout.decode().strip() == owner["forwardIdentity"]:
        os.killpg(pid, signal.SIGKILL)
    raise RuntimeError("Forward required forced cleanup")


def finish_owned_forward(child):
    if child.poll() is not None:
        return
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
        raise RuntimeError("Owned forward required forced rollback cleanup")


def wait_for_receipt(read, key, value, process_id, action=None, timeout=20):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            receipt = read()
            last = {field: receipt.get(field) for field in [key, "status", "processId", "action"]}
            if receipt.get(key) == value and receipt.get("processId") == process_id and (action is None or receipt.get("action") == action):
                return receipt
        except subprocess.CalledProcessError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"No matching fresh device development receipt for process {process_id}; last identity: {last}")


def physical(args):
    owner_path = args.output.with_suffix(args.output.suffix + ".owner.json")
    domain = ["--device", args.device, "--domain-type", "appDataContainer", "--domain-identifier", PACKAGE]
    with tempfile.TemporaryDirectory(prefix="nh-refresh-ios-") as temporary:
        temp = Path(temporary)

        def device(arguments):
            output = temp / "command.json"
            result = call(["xcrun", "devicectl", *arguments, "--json-output", str(output)], timeout=45)
            data = json.loads(output.read_bytes())
            if data.get("info", {}).get("outcome") != "success":
                raise RuntimeError("Device command did not report success")
            return data.get("result", {})

        def remote_json(name):
            target = temp / name
            target.unlink(missing_ok=True)
            device(["device", "copy", "from", *domain, "--source", f"Documents/{name}", "--destination", str(target)])
            target.chmod(0o600)
            return private_json(target)

        def launch(*arguments):
            # devicectl's first -- ends its arguments, so JSON-output must precede it.
            output = temp / "launch.json"
            call(["xcrun", "devicectl", "device", "process", "launch", "--device", args.device,
                  "--terminate-existing", "--json-output", str(output), PACKAGE, "--", *arguments], timeout=45)
            data = json.loads(output.read_bytes())
            if data.get("info", {}).get("outcome") != "success":
                raise RuntimeError("Device launch did not report success")
            pid = data.get("result", {}).get("process", {}).get("processIdentifier")
            if type(pid) is not int or pid <= 0:
                raise ValueError("Device launch did not identify its new process")
            return pid

        def wait_receipt(name, key, value, process_id, action=None):
            return wait_for_receipt(lambda: remote_json(name), key, value, process_id, action)

        def end_session(session_id):
            pid = launch("--native-host-end-session", session_id)
            receipt = wait_receipt("native-dev-stage.json", "sessionId", session_id, pid, "end-session")
            if receipt.get("status") != "disconnected":
                raise RuntimeError("Device did not remove the owned development session")

        if args.disconnect:
            desktop, owner = private_json(args.output), private_json(owner_path)
            if owner.get("device") != args.device or owner.get("sessionId") != desktop.get("sessionId") or owner.get("port") != desktop.get("port"):
                raise ValueError("Device forward ownership mismatch")
            errors = []
            for operation in [lambda: stop_forward(owner), lambda: end_session(desktop["sessionId"])]:
                try:
                    operation()
                except Exception as error:
                    errors.append(error)
            if errors:
                raise ExceptionGroup("Device disconnect incomplete", errors)
            print(json.dumps({"status": "disconnected", "sessionId": desktop["sessionId"]}))
            return
        config, directory = configuration(args)
        for file in [args.output, owner_path]:
            if file.exists() or file.is_symlink():
                raise ValueError("Refusing to overwrite a desktop development session")
        files = device(["device", "info", "files", *domain, "--subdirectory", "Documents", "--no-recurse"])
        if any(file.get("name") == "native-dev-session.json" for file in files.get("files", [])):
            raise ValueError("Refusing to replace an existing device development session")
        forward = None
        remote_owned = False
        owner = None
        created = []
        try:
            pid = launch("--native-host-stage-revision", directory.name)
            prepared = wait_receipt("native-dev-stage.json", "revision", directory.name, pid, "prepare-revision")
            if prepared.get("status") != "prepared":
                raise RuntimeError("Device refused to reserve the new revision directory")
            for name in ["app.bundle.js", "app.bundle.js.map", "manifest.json"]:
                device(["device", "copy", "to", *domain, "--source", str(directory / name),
                        "--destination", f"Documents/dev-revisions/{directory.name}/{name}"])
            # Mark ownership before transfer: cleanup checks session identity even
            # if the copying command loses its acknowledgement.
            remote_owned = True
            device(["device", "copy", "to", *domain, "--source", str(args.session.resolve()), "--destination", "Documents/native-dev-session.json"])
            pid = launch("--native-host-revision", directory.name)
            receipt = wait_receipt("native-dev-ready.json", "sessionId", config["sessionId"], pid)
            if receipt.get("status") != "ready" or receipt.get("initialRevision") != directory.name:
                raise RuntimeError("Device development host did not become ready")
            device_port = receipt.get("port")
            if type(device_port) is not int or not 1024 <= device_port <= 65535:
                raise ValueError("Invalid device loopback port")
            with socket.socket() as reserve:
                reserve.bind(("127.0.0.1", 0))
                port = reserve.getsockname()[1]
            args.output.parent.mkdir(parents=True, exist_ok=True)
            log = args.output.with_suffix(args.output.suffix + ".iproxy.log")
            with log.open("xb") as output:
                forward = subprocess.Popen(["iproxy", "-u", args.device, "-s", "127.0.0.1", f"{port}:{device_port}"],
                                           stdout=output, stderr=output, start_new_session=True)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if forward.poll() is not None:
                    raise RuntimeError("Owned USB forward exited before listening")
                listening = call(["lsof", "-nP", "-a", "-p", str(forward.pid), f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], check=False)
                if listening.stdout.decode().strip() == str(forward.pid):
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("Owned USB forward did not listen")
            identity = call(["/bin/ps", "-p", str(forward.pid), "-o", "lstart=", "-o", "command="]).stdout.decode().strip()
            owner = {"device": args.device, "sessionId": config["sessionId"], "port": port, "devicePort": device_port,
                     "forwardPid": forward.pid, "forwardIdentity": identity}
            write_private(owner_path, owner)
            created.append(owner_path)
            write_private(args.output, {**config, "host": "127.0.0.1", "port": port})
            created.append(args.output)
            print(json.dumps({"status": "ready", "config": str(args.output.resolve()), "sessionId": config["sessionId"],
                              "generation": receipt["generation"], "processId": receipt["processId"], "port": port,
                              "artifactHashes": receipt.get("artifactHashes"), "stagingReceipt": prepared, "device": args.device}))
        except BaseException as primary:
            errors = []
            operations = []
            if forward is not None and forward.poll() is None:
                operations.append(lambda: finish_owned_forward(forward))
            if remote_owned:
                operations.append(lambda: end_session(config["sessionId"]))
            for file in created:
                operations.append(lambda file=file: file.unlink() if private_json(file).get("sessionId") == config["sessionId"] else None)
            for operation in operations:
                try:
                    operation()
                except Exception as error:
                    errors.append(error)
            if errors:
                raise BaseExceptionGroup("Device connection failed with incomplete cleanup", [primary, *errors])
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--simulator")
    target.add_argument("--device")
    parser.add_argument("--session", type=Path)
    parser.add_argument("--revision-directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--disconnect", action="store_true")
    args = parser.parse_args()
    if args.device:
        return physical(args)

    def sim(command, *arguments, check=True):
        options = []
        if command == "launch" and arguments[:1] == ("--terminate-running-process",):
            options, arguments = [arguments[0]], arguments[1:]
        return call(["xcrun", "simctl", command, *options, args.simulator, *arguments], check=check).stdout.decode().strip()

    container = Path(sim("get_app_container", PACKAGE, "data")).resolve(strict=True)
    remote_config = container / "native-dev-session.json"
    receipt_path = container / "native-dev-ready.json"
    owner_path = args.output.with_suffix(args.output.suffix + ".owner.json")
    if args.disconnect:
        desktop, owner = private_json(args.output), private_json(owner_path)
        if owner.get("simulator") != args.simulator or owner.get("sessionId") != desktop.get("sessionId") or owner.get("container") != str(container):
            raise ValueError("Development session ownership mismatch")
        if remote_config.exists() and private_json(remote_config).get("sessionId") == desktop["sessionId"]:
            remote_config.unlink()
        print(json.dumps({"status": "disconnected", "sessionId": desktop["sessionId"]}))
        return
    if args.session is None or args.revision_directory is None:
        parser.error("--session and --revision-directory are required")
    for file in [args.output, owner_path, remote_config]:
        if file.exists() or file.is_symlink():
            raise ValueError("Refusing to replace an existing development session configuration")
    config, directory = configuration(args)
    call(["bash", str(ROOT / "platforms/ios/deploy-revision.sh"), str(directory)],
         env={**os.environ, "NH_SIMULATOR_ID": args.simulator, "NH_STAGE_ONLY": "1"})
    created = []
    try:
        write_private(remote_config, config)
        created.append(remote_config)
        sim("launch", "--terminate-running-process", PACKAGE, "--native-host-revision", directory.name)
        deadline, receipt = time.monotonic() + 20, None
        while time.monotonic() < deadline:
            if receipt_path.exists():
                candidate = private_json(receipt_path)
                if candidate.get("sessionId") == config["sessionId"]:
                    receipt = candidate
                    break
            time.sleep(0.1)
        if not receipt or receipt.get("status") != "ready":
            raise RuntimeError("No matching development ready receipt")
        port = receipt.get("port")
        if type(port) is not int or not 1024 <= port <= 65535 or receipt.get("initialRevision") != directory.name or not re.fullmatch("[1-9][0-9]*", receipt.get("generation", "")):
            raise ValueError("Invalid development receipt identity")
        desktop = {**config, "host": "127.0.0.1", "port": port}
        write_private(owner_path, {"simulator": args.simulator, "sessionId": config["sessionId"], "container": str(container), "port": port})
        created.append(owner_path)
        write_private(args.output, desktop)
        created.append(args.output)
        print(json.dumps({"status": "ready", "config": str(args.output.resolve()), "sessionId": config["sessionId"],
                          "generation": receipt["generation"], "processId": receipt["processId"], "port": port}))
    except BaseException as primary:
        errors = []
        for file in created:
            try:
                if file.exists() and private_json(file).get("sessionId") == config["sessionId"]:
                    file.unlink()
            except Exception as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("Development connection failed with incomplete cleanup", [primary, *errors])
        raise


if __name__ == "__main__":
    def interrupted(number, frame):
        raise ConnectorInterrupted("Development connection interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main()
