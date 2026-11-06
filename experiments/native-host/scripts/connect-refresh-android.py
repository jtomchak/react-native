#!/usr/bin/env python3
"""Stage a Refresh bootstrap, opt in one Debug session, and forward its loopback port.

The private output config belongs to the desktop Rust transport. No token is
printed or passed in argv. Use --disconnect with that config after the session.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import shlex
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "dev.nativehost.experiment"
DEVICE_CONFIG = "files/native-dev-session.json"


class DeploymentInterrupted(RuntimeError):
    """Distinct from InterruptedError, which selectors can treat as retryable."""


def signal_owned_group(process_id, number):
    try:
        os.killpg(process_id, number)
    except ProcessLookupError:
        pass
    except PermissionError:
        # macOS can transiently report EPERM as a terminated group disappears.
        # A live/inaccessible group is still a failure; only proven ESRCH is safe.
        try:
            os.killpg(process_id, 0)
        except ProcessLookupError:
            return
        raise


def run_deployment(arguments, timeout=60):
    """Own the deployer and its adb descendants, including interrupted launches."""
    child = subprocess.Popen(arguments, stdout=subprocess.PIPE, start_new_session=True)
    old_handlers = {}

    def interrupt(number, frame):
        raise DeploymentInterrupted("Deployment interrupted")

    def signal_group(number):
        signal_owned_group(child.pid, number)

    try:
        for number in (signal.SIGINT, signal.SIGTERM):
            old_handlers[number] = signal.signal(number, interrupt)
        stdout, _ = child.communicate(timeout=timeout)
        if child.returncode:
            raise subprocess.CalledProcessError(child.returncode, arguments, output=stdout)
        return stdout
    except BaseException as primary:
        cleanup_errors = []
        try:
            signal_group(signal.SIGTERM)
        except Exception as error:
            cleanup_errors.append(error)
        try:
            child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        except Exception as error:
            cleanup_errors.append(error)
        # Even if the deployer exits promptly, an inherited adb subprocess may
        # still be waiting for Android's launch acknowledgement.
        try:
            signal_group(signal.SIGKILL)
        except Exception as error:
            cleanup_errors.append(error)
        try:
            child.communicate(timeout=1)
        except Exception as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup("Deployment failed and process cleanup was incomplete", [primary, *cleanup_errors])
        raise
    finally:
        for number, handler in old_handlers.items():
            signal.signal(number, handler)


def private_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16384:
        raise ValueError("Expected a bounded regular private configuration file")
    if path.stat().st_mode & 0o077:
        raise ValueError("Private configuration must not be group/world accessible")
    return json.loads(path.read_bytes())


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".refresh-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        # Publish without clobbering a file created after the initial check.
        os.link(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--session", type=Path)
    parser.add_argument("--revision-directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--disconnect", action="store_true")
    args = parser.parse_args()
    adb = ["adb", "-s", args.serial]

    def call(arguments, data=None, check=True):
        return subprocess.run(adb + arguments, input=data, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, check=check, timeout=30)

    def app_shell(command, data=None, check=True):
        return call(["shell", f"run-as {PACKAGE} sh -c {shlex.quote(command)}"], data, check)

    if args.disconnect:
        desktop = private_json(args.output)
        owner = private_json(args.output.with_suffix(args.output.suffix + ".forward.json"))
        if owner["serial"] != args.serial or owner["sessionId"] != desktop["sessionId"] or owner["localPort"] != desktop["port"]:
            raise ValueError("Forward ownership mismatch")
        expected = f"{args.serial} tcp:{owner['localPort']} tcp:{owner['devicePort']}"
        mappings = call(["forward", "--list"]).stdout.decode().splitlines()
        if expected in mappings:
            call(["forward", "--remove", f"tcp:{owner['localPort']}"])
        elif any(line.split()[1:2] == [f"tcp:{owner['localPort']}"] for line in mappings):
            raise ValueError("Forward was replaced; refusing to remove it")
        # Do not delete a newer app session. The Debug listener exits with its
        # Activity; this removes the opt-in for this session's next launch only.
        remote = app_shell(f"cat {DEVICE_CONFIG}", check=False)
        if remote.returncode == 0:
            value = json.loads(remote.stdout)
            if value.get("sessionId") == desktop["sessionId"]:
                app_shell(f"rm {DEVICE_CONFIG}")
        print(json.dumps({"status": "disconnected", "sessionId": desktop["sessionId"]}))
        return

    if args.session is None or args.revision_directory is None:
        parser.error("--session and --revision-directory are required for connection")
    owner_path = args.output.with_suffix(args.output.suffix + ".forward.json")
    if args.output.exists() or args.output.is_symlink() or owner_path.exists() or owner_path.is_symlink():
        raise ValueError("Refusing to overwrite an existing desktop session configuration")
    config = private_json(args.session)
    keys = {"schemaVersion", "token", "sessionId", "initialRevision", "initialBundleSha256", "port"}
    if set(config) != keys or type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1:
        raise ValueError("Unexpected device session schema")
    for name, length in [("token", 64), ("sessionId", 32), ("initialBundleSha256", 64)]:
        if not isinstance(config[name], str) or not re.fullmatch(f"[a-f0-9]{{{length}}}", config[name]):
            raise ValueError(f"Invalid {name}")
    if type(config["port"]) is not int or not (config["port"] == 0 or 1024 <= config["port"] <= 65535):
        raise ValueError("Invalid device port")
    directory = args.revision_directory.resolve()
    if not re.fullmatch("[0-9]{1,64}", directory.name) or config["initialRevision"] != directory.name:
        raise ValueError("Initial revision mismatch")
    manifest = json.loads((directory / "manifest.json").read_bytes())
    if manifest.get("sha256") != config["initialBundleSha256"]:
        raise ValueError("Initial digest mismatch")
    deploy = [sys.executable, str(ROOT / "platforms/android/deploy-revision.py"), str(directory), "--serial", args.serial]
    run_deployment(deploy + ["--stage-only"])
    # The token is stdin data, never shell source or argv.
    temporary = f"files/.native-dev-session-{config['sessionId']}.tmp"
    forwarded = None
    created = []
    try:
        app_shell(f"umask 077; cat > {temporary} && chmod 600 {temporary} && mv {temporary} {DEVICE_CONFIG}",
                  json.dumps(config).encode())
        run_deployment(deploy)
        deadline = time.monotonic() + 15
        receipt = None
        while time.monotonic() < deadline:
            result = app_shell("cat files/native-dev-ready.json", check=False)
            if result.returncode == 0:
                candidate = json.loads(result.stdout)
                if candidate.get("sessionId") == config["sessionId"]:
                    receipt = candidate
                    break
            time.sleep(0.1)
        if not receipt or receipt.get("status") != "ready":
            raise RuntimeError("Development listener did not publish a matching ready receipt")
        port = receipt.get("port")
        if type(port) is not int or not 1024 <= port <= 65535 or receipt.get("initialRevision") != config["initialRevision"]:
            raise ValueError("Malformed development listener receipt")
        forwarded = int(call(["forward", "tcp:0", f"tcp:{port}"]).stdout)
        desktop = {**config, "host": "127.0.0.1", "port": forwarded}
        write_private(owner_path, {
            "serial": args.serial, "sessionId": config["sessionId"], "localPort": forwarded, "devicePort": port})
        created.append(owner_path)
        write_private(args.output, desktop)
        created.append(args.output)
        print(json.dumps({"status": "ready", "config": str(args.output.resolve()),
                          "sessionId": config["sessionId"], "generation": receipt.get("generation"),
                          "processId": receipt.get("processId"), "port": forwarded}))
    except BaseException as primary:
        cleanup_errors = []

        def cleanup(task):
            try:
                task()
            except Exception as error:
                cleanup_errors.append(error)

        if forwarded is not None:
            cleanup(lambda: call(["forward", "--remove", f"tcp:{forwarded}"]))
        # Only these paths were reserved by this invocation. The caller restores
        # its selected app fixture separately after a failed launch.
        for local in created:
            def remove_local(local=local):
                if local.exists() and private_json(local).get("sessionId") == config["sessionId"]:
                    local.unlink()
            cleanup(remove_local)

        def remove_config():
            remote = app_shell(f"cat {DEVICE_CONFIG}", check=False)
            if remote.returncode == 0 and json.loads(remote.stdout).get("sessionId") == config["sessionId"]:
                app_shell(f"rm {DEVICE_CONFIG}")
        cleanup(remove_config)
        cleanup(lambda: app_shell(f"rm -f {temporary}"))
        if cleanup_errors:
            raise BaseExceptionGroup("Connection failed and rollback was incomplete", [primary, *cleanup_errors])
        raise


if __name__ == "__main__":
    main()
