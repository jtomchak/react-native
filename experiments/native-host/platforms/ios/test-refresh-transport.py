#!/usr/bin/env python3
"""Exercise Debug-only loopback delivery in a selected iOS simulator, without XCTest.

This validates transport/C-ABI scripts, not React Refresh semantics. It restores
the prior private config and relaunches the packaged fixture on completion.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import time

PACKAGE = "dev.nativehost.prototype"
LIMIT = 4 * 1024 * 1024 * 2 + 16384


def sim(device, *args, check=True):
    return subprocess.run(["xcrun", "simctl", *args[:1], device, *args[1:]],
                          check=check, capture_output=True, text=True).stdout.strip()


def write_config(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    temporary.chmod(0o600)
    temporary.replace(path)


def exact(stream, count):
    result = bytearray()
    while len(result) < count:
        part = stream.recv(count - len(result))
        if not part:
            raise EOFError("Transport closed")
        result.extend(part)
    return bytes(result)


def send(stream, value):
    body = value if isinstance(value, bytes) else json.dumps(value, separators=(",", ":")).encode()
    stream.sendall(struct.pack(">I", len(body)) + body)


def receive(stream):
    length = struct.unpack(">I", exact(stream, 4))[0]
    assert 0 < length <= LIMIT
    return json.loads(exact(stream, length))


def request(stream, value):
    send(stream, value)
    return receive(stream)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simulator", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    container = Path(sim(args.simulator, "get_app_container", PACKAGE, "data"))
    app = Path(sim(args.simulator, "get_app_container", PACKAGE, "app"))
    config_file = container / "native-dev-session.json"
    receipt_file = container / "native-dev-ready.json"
    previous = config_file.read_bytes() if config_file.exists() else None
    previous_mode = config_file.stat().st_mode & 0o777 if previous is not None else None
    report = {"schemaVersion": 1, "status": "running", "checks": [], "errors": [], "simulator": args.simulator,
              "evidenceScope": "native development transport; scripts are not React Refresh patches"}
    config = {"schemaVersion": 1, "token": secrets.token_hex(32), "sessionId": secrets.token_hex(16),
              "initialRevision": "packaged-development", "initialBundleSha256": hashlib.sha256((app / "app.bundle.js").read_bytes()).hexdigest(), "port": 0}
    executable = app / "NativeHost"
    report["executableSha256Before"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    report["bundleSha256"] = config["initialBundleSha256"]

    def runtime_hashes():
        # Xcode Debug uses a small launcher plus NativeHost.debug.dylib. Hashing
        # only the launcher would miss changes to the actual implementation.
        artifacts = [executable, app / "app.bundle.js", *sorted(app.glob("*.dylib"))]
        hermes = app / "Frameworks/hermesvm.framework/hermesvm"
        assert hermes.is_file()
        artifacts.append(hermes)
        return {str(file.relative_to(app)): hashlib.sha256(file.read_bytes()).hexdigest() for file in artifacts}

    report["runtimeArtifactsBefore"] = runtime_hashes()
    stream = None

    def launch():
        sim(args.simulator, "terminate", PACKAGE, check=False)
        if receipt_file.exists():
            receipt_file.unlink()
        sim(args.simulator, "launch", PACKAGE)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if receipt_file.exists():
                return json.loads(receipt_file.read_text())
            time.sleep(0.05)
        raise TimeoutError("No development receipt")

    def connect(auth=True):
        connection = socket.create_connection(("127.0.0.1", receipt["port"]), 5)
        connection.settimeout(5)
        if auth:
            assert request(connection, {"method": "authenticate", "token": config["token"]}) == {"id": None, "result": {"authenticated": True}}
        return connection

    def patch(sequence, base, target, source):
        payload = source.encode()
        return {"method": "dev.enqueue", "generation": receipt["generation"], "sessionId": config["sessionId"],
                "sequence": str(sequence), "baseRevision": base, "targetRevision": target,
                "payloadSha256": hashlib.sha256(payload).hexdigest(), "payloadHex": payload.hex()}

    def apply(value):
        result = request(stream, value)["result"]
        if result["status"] == "queued":
            result = request(stream, {"method": "dev.drain"})["result"]
        assert result["status"] == "applied", result
        assert result["sequence"] == value["sequence"] and result["targetRevision"] == value["targetRevision"]
        assert result["payloadSha256"] == value["payloadSha256"] and str(result["generation"]) == receipt["generation"]
        return result

    try:
        write_config(config_file, {**config, "initialRevision": "wrong-revision"})
        rejected = launch()
        assert rejected["status"] == "error" and rejected["port"] == 0
        report["checks"].append("stale-config-does-not-enable-listener")
        config_file.write_text(json.dumps(config)[:-1] + ',"schemaVersion":1}')
        rejected = launch()
        assert rejected["status"] == "error" and rejected["port"] == 0
        report["checks"].append("duplicate-config-rejected")
        config_file.unlink()
        os.mkfifo(config_file, 0o600)
        fifo_start = time.monotonic()
        rejected = launch()
        assert rejected["status"] == "error" and rejected["port"] == 0
        assert rejected["error"] == "Invalid configuration file"
        report["fifoStartupSeconds"] = time.monotonic() - fifo_start
        report["checks"].append("fifo-config-with-no-writer-rejected-without-blocking-startup")
        write_config(config_file, config)
        receipt = launch()
        assert receipt["status"] == "ready" and 0 < receipt["port"] < 65536
        assert receipt["sessionId"] == config["sessionId"] and "token" not in receipt
        assert (container / "dev-revisions").is_dir()
        report["receipt"] = receipt
        process_start = subprocess.run(["/bin/ps", "-p", str(receipt["processId"]), "-o", "lstart="],
                                       check=True, capture_output=True, text=True).stdout.strip()
        assert process_start
        report["processStart"] = process_start
        report["checks"].append("private-config-real-host-open-and-staging-root")
        with connect(False) as connection:
            assert "error" in request(connection, {"method": "authenticate", "token": "0" * 64})
        report["checks"].append("wrong-token-rejected")
        with connect(False) as connection:
            assert "error" in request(connection, {"method": "dev.status"})
        report["checks"].append("authentication-required")
        with connect(False) as connection:
            assert "error" in request(connection, b'{"method":"authenticate","method":"authenticate","token":"' + config["token"].encode() + b'"}')
        report["checks"].append("duplicate-command-rejected")
        with connect(False) as connection:
            assert "error" in request(connection, b'{"method":"authenticate","token":"\xff"}')
        report["checks"].append("non-ascii-control-rejected")
        with connect(False) as connection:
            connection.sendall(struct.pack(">I", LIMIT + 1))
            assert connection.recv(1) == b""
        report["checks"].append("oversized-frame-rejected-before-body")
        with connect() as connection:
            assert "error" in request(connection, {"method": "runtime.eval"})
        report["checks"].append("test-eval-not-exposed")
        stream = connect()
        before = request(stream, {"method": "dev.status"})["result"]
        assert before["acceptedSequence"] == "0" and before["opened"] and not before["reloadRequired"]
        first = patch(1, config["initialRevision"], "transport-1", 'globalThis.__transportCount=1;globalThis.__transportUnicode="café 😀";({status:"applied"});')
        assert "error" in request(stream, {**first, "generation": str(int(receipt["generation"]) + 1)})
        assert "error" in request(stream, {**first, "payloadSha256": "0" * 64})
        assert "error" in request(stream, {**first, "baseRevision": "wrong-base"})
        assert request(stream, {"method": "dev.status"})["result"]["acceptedSequence"] == "0"
        report["checks"].append("identity-digest-base-rejected-before-sequence-consumption")
        first_result = apply(first)
        assert request(stream, first)["result"] == first_result
        report["checks"].append("native-apply-and-terminal-duplicate-replay")
        second = patch(2, "transport-1", "transport-2", 'if(__transportCount!==1||__transportUnicode!=="café 😀")throw Error("state changed");__transportCount=2;({status:"applied"});')
        assert request(stream, second)["result"]["status"] == "queued"
        send(stream, {"method": "dev.drain"})
        stream.close()
        stream = connect()
        apply(second)
        apply(patch(3, "transport-2", "transport-3", 'if(__transportCount!==2)throw Error("duplicate executed");__transportCount=3;({status:"applied"});'))
        report["checks"].append("disconnect-around-drain-replayed-without-double-execution")
        broken = patch(4, "transport-3", "transport-4", 'function {')
        assert request(stream, broken)["result"]["status"] == "queued"
        assert request(stream, {"method": "dev.drain"})["result"]["status"] == "rejected"
        apply(patch(5, "transport-3", "transport-5", 'if(__transportCount!==3)throw Error("prepare changed state");__transportCount=4;({status:"applied"});'))
        report["checks"].append("prepare-rejection-preserves-state-and-next-sequence")
        after = request(stream, {"method": "dev.status"})["result"]
        assert after["generation"] == before["generation"] and after["revision"] == "transport-5"
        assert after["acceptedSequence"] == "5" and not after["pending"]
        actual_process_start = subprocess.run(["/bin/ps", "-p", str(receipt["processId"]), "-o", "lstart="],
                                              check=True, capture_output=True, text=True).stdout.strip()
        assert actual_process_start == process_start
        report["checks"].append("same-generation-ordered-updates")
        poison = patch(6, "transport-5", "transport-6", 'throw Error("intentional transport poison");')
        assert request(stream, poison)["result"]["status"] == "queued"
        assert request(stream, {"method": "dev.drain"})["result"]["status"] == "reload-required"
        assert request(stream, {"method": "dev.status"})["result"]["reloadRequired"]
        report["checks"].append("execution-failure-requires-reload")
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["errors"].append(f"{type(error).__name__}: {error}")
    finally:
        if stream:
            stream.close()
        try:
            report["executableSha256After"] = hashlib.sha256(executable.read_bytes()).hexdigest()
            assert report["executableSha256After"] == report["executableSha256Before"]
            report["runtimeArtifactsAfter"] = runtime_hashes()
            assert report["runtimeArtifactsAfter"] == report["runtimeArtifactsBefore"]
        except Exception as error:
            report["status"] = "failed"
            report["errors"].append(f"artifact-check: {type(error).__name__}: {error}")
        try:
            sim(args.simulator, "terminate", PACKAGE, check=False)
        except Exception as error:
            report["status"] = "failed"
            report["errors"].append(f"terminate: {type(error).__name__}: {error}")
        try:
            if previous is None:
                config_file.unlink(missing_ok=True)
            else:
                restored = config_file.with_suffix(".restore.tmp")
                restored.write_bytes(previous)
                restored.chmod(previous_mode)
                restored.replace(config_file)
        except Exception as error:
            report["status"] = "failed"
            report["errors"].append(f"restore-config: {type(error).__name__}: {error}")
        try:
            sim(args.simulator, "launch", PACKAGE)
        except Exception as error:
            report["status"] = "failed"
            report["errors"].append(f"cleanup: {type(error).__name__}: {error}")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "checks": len(report["checks"]), "report": str(args.report)}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
