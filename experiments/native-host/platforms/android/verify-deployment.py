#!/usr/bin/env python3
"""Exercise debug full-reload deployment and release override rejection on a task device.

Requires already-built debug, instrumentation and release APKs. Never runs a
native build. Uses intentionally generated transport fixtures, not watcher
performance evidence. Temporarily installs a debug-key-signed release test APK.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
EXPERIMENT = ROOT.parent.parent
PACKAGE = "dev.nativehost.experiment"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--android-sdk", type=Path, required=True)
    args = parser.parse_args()
    adb = ["adb", "-s", args.serial]
    evidence = ROOT / ".cache/deploy-verification"
    evidence.mkdir(parents=True, exist_ok=True)
    debug = ROOT / "app/build/outputs/apk/debug/app-debug.apk"
    tests = ROOT / "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
    release = ROOT / "app/build/outputs/apk/release/app-release-unsigned.apk"
    debug_hash = hashlib.sha256(debug.read_bytes()).hexdigest()
    report = {"kind": "android-debug-deployment", "fixtureKind": "generated bundle transport fixtures", "serial": args.serial, "nativeBuildPerformed": False, "debugApkSha256": debug_hash, "cases": []}

    def command(arguments, check=True, data=None):
        return subprocess.run(arguments, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check, timeout=45)

    def shell(*arguments, check=True):
        return command(adb + ["shell"] + list(arguments), check=check).stdout.decode()

    def record(name, **details):
        report["cases"].append({"case": name, "status": "passed", **details})
        print("PASS " + name, flush=True)

    def launch(revision=None):
        shell("am", "force-stop", PACKAGE)
        arguments = ["am", "start", "-W", "-n", PACKAGE + "/dev.nativehost.HostActivity"]
        if revision is not None:
            arguments += ["--es", "devRevision", revision]
        shell(*arguments)

    def tree_with(text, filename):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            shell("uiautomator", "dump", "/sdcard/native-host-deploy.xml", check=False)
            xml = shell("cat", "/sdcard/native-host-deploy.xml", check=False)
            if xml.startswith("<?xml"):
                tree = ET.fromstring(xml)
                if any(node.attrib.get("text") == text or text in node.attrib.get("text", "") for node in tree.iter("node")):
                    (evidence / filename).write_text(xml)
                    return tree
            time.sleep(.1)
        raise AssertionError("Native text not observed: " + text)

    def inspect_session(revision):
        token = secrets.token_hex(32)
        port = int(command(adb + ["forward", "tcp:0", "tcp:18771"]).stdout.decode().strip())
        output = (evidence / ("driver-" + revision + ".log")).open("w")
        process = subprocess.Popen(adb + ["shell", "am", "instrument", "-w", "-e", "mode", "server", "-e", "token", token, "-e", "port", "18771", "-e", "revision", revision, PACKAGE + ".test/dev.nativehost.HostInstrumentation"], stdout=output, stderr=subprocess.STDOUT)
        connection = stream = None
        try:
            for _ in range(100):
                try:
                    connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                    stream = connection.makefile("rwb")
                    stream.write((json.dumps({"id": 0, "method": "session.authenticate", "params": {"token": token}}) + "\n").encode()); stream.flush()
                    if json.loads(stream.readline()).get("result", {}).get("authenticated"):
                        break
                except (OSError, ValueError):
                    if stream: stream.close()
                    if connection: connection.close()
                    stream = connection = None
                    if process.poll() is not None: raise RuntimeError("Instrumentation exited before startup observation")
                    time.sleep(.2)
            if connection is None: raise RuntimeError("No instrumentation startup observer")
            connection.settimeout(15)
            observations = {}
            for index, method in enumerate(["session.describe", "session.health", "session.close"], 1):
                stream.write((json.dumps({"id": index, "method": method, "params": {}}) + "\n").encode()); stream.flush()
                response = json.loads(stream.readline())
                if "error" in response: raise AssertionError(response)
                observations[method] = response["result"]
            process.wait(timeout=15)
            return observations
        finally:
            if stream: stream.close()
            if connection: connection.close()
            if process.poll() is None: process.terminate()
            command(adb + ["forward", "--remove", f"tcp:{port}"], check=False)
            output.close()

    try:
        for apk in [debug, tests]: command(adb + ["install", "-r", str(apk)])
        original = (EXPERIMENT / "build/app.bundle.js").read_bytes()
        original_map = (EXPERIMENT / "build/app.bundle.js.map").read_bytes()
        if original.count(b"Native host prototype") != 1:
            raise AssertionError("Expected single demo heading in transport fixture")
        seed = str(time.time_ns()) + str(secrets.randbelow(10**19)).zfill(19)
        revisions = []
        for index, label in enumerate(["Android deployed revision A", "Android deployed revision B"]):
            revision = seed + str(index).zfill(3)
            directory = evidence / revision
            directory.mkdir()
            bundle = original.replace(b"Native host prototype", label.encode())
            # These source maps are transport fixtures only; no mapping claim is made.
            (directory / "app.bundle.js").write_bytes(bundle)
            (directory / "app.bundle.js.map").write_bytes(original_map)
            manifest = {"schemaVersion": 1, "revision": revision, "sha256": hashlib.sha256(bundle).hexdigest(), "byteLength": len(bundle), "sourceMap": {"file": "app.bundle.js.map", "sha256": hashlib.sha256(original_map).hexdigest(), "byteLength": len(original_map)}, "createdAt": datetime.now(timezone.utc).isoformat(), "mode": "development", "reload": "full", "buildDurationMs": 0}
            (directory / "manifest.json").write_text(json.dumps(manifest))
            revisions.append((revision, directory, label))
        first, second = revisions
        deploy_a = json.loads(command([sys.executable, str(ROOT / "deploy-revision.py"), str(first[1]), "--serial", args.serial]).stdout)
        tree = tree_with(first[2], "revision-a.xml")
        button = next(node for node in tree.iter("node") if node.attrib.get("content-desc") == "Increment")
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", button.attrib["bounds"]))
        shell("input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        tree_with("Count: 1", "revision-a-state.xml")
        record("first-revision-native-heading-and-real-input", deployment=deploy_a)
        deploy_b = json.loads(command([sys.executable, str(ROOT / "deploy-revision.py"), str(second[1]), "--serial", args.serial]).stdout)
        tree = tree_with(second[2], "revision-b.xml")
        assert any(n.attrib.get("text") == "Count: 0" for n in tree.iter("node"))
        assert deploy_b["previousProcessId"] == deploy_a["processId"] and deploy_b["processId"] != deploy_a["processId"]
        assert deploy_b["shutdownAcknowledgement"] == "host-destroyed"
        record("second-revision-process-restart-and-fresh-react-state", deployment=deploy_b)
        identity = inspect_session(second[0])
        assert identity["session.describe"]["bundleRevision"] == second[0]
        assert identity["session.describe"]["runtimeGeneration"] is not None and identity["session.health"]["healthy"]
        record("exact-revision-driver-identity-and-health", observations=identity)
        # Corrupt a task-owned staged fixture, bypassing client validation to test
        # the native startup verifier rather than merely the deployment script.
        corrupt = seed + "999"
        shell("run-as", PACKAGE, "cp", "-R", "files/dev-revisions/" + first[0], "files/dev-revisions/" + corrupt)
        bad = json.loads((first[1] / "manifest.json").read_text()); bad["revision"] = corrupt; bad["sha256"] = "0" * 64
        import shlex
        remote = f"run-as {PACKAGE} sh -c " + shlex.quote(f"cat > files/dev-revisions/{corrupt}/manifest.json")
        command(adb + ["shell", remote], data=json.dumps(bad).encode())
        launch(corrupt)
        tree_with("Development bundle SHA256 mismatch", "corrupt-rejected.xml")
        rejection = inspect_session(corrupt)
        assert rejection["session.health"]["healthy"] is False and rejection["session.describe"]["runtimeStarted"] is False
        record("native-corrupt-revision-rejected-before-hermes", observations=rejection)
        for suffix, mutation, expected in [
            ("997", "corrupt", "Development bundle SHA256 mismatch: app.bundle.js.map"),
            ("998", "missing", "Missing or symlinked development file: app.bundle.js.map"),
        ]:
            map_revision = seed + suffix
            shell("run-as", PACKAGE, "cp", "-R", "files/dev-revisions/" + first[0], "files/dev-revisions/" + map_revision)
            map_manifest = json.loads((first[1] / "manifest.json").read_text()); map_manifest["revision"] = map_revision
            remote = f"run-as {PACKAGE} sh -c " + shlex.quote(f"cat > files/dev-revisions/{map_revision}/manifest.json")
            command(adb + ["shell", remote], data=json.dumps(map_manifest).encode())
            if mutation == "missing":
                shell("run-as", PACKAGE, "rm", f"files/dev-revisions/{map_revision}/app.bundle.js.map")
            else:
                remote = f"run-as {PACKAGE} sh -c " + shlex.quote(f"cat > files/dev-revisions/{map_revision}/app.bundle.js.map")
                command(adb + ["shell", remote], data=bytes([original_map[0] ^ 1]) + original_map[1:])
            launch(map_revision)
            tree_with(expected, f"{mutation}-map-rejected.xml")
            map_rejection = inspect_session(map_revision)
            assert map_rejection["session.health"]["healthy"] is False and map_rejection["session.describe"]["runtimeStarted"] is False
            record(f"native-{mutation}-source-map-rejected-before-hermes", observations=map_rejection)
        launch("../invalid")
        tree_with("Invalid development revision", "invalid-path-rejected.xml")
        record("native-nondigit-revision-rejected")
        signed = evidence / "release-test-signed.apk"
        apksigner = args.android_sdk / "build-tools/35.0.0/apksigner"
        command([str(apksigner), "sign", "--ks", str(Path.home() / ".android/debug.keystore"), "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", str(signed), str(release)])
        command(adb + ["install", "-r", str(signed)])
        launch(first[0])
        tree_with("Native host prototype", "release-ignores-override.xml")
        rejected = command(adb + ["shell", "run-as", PACKAGE, "id"], check=False)
        assert rejected.returncode != 0
        record("real-release-ignores-staged-override-and-disallows-run-as")
        assert hashlib.sha256(debug.read_bytes()).hexdigest() == debug_hash
        report["status"] = "passed"
    finally:
        # Restore only this task package, leaving the task device available to the parent.
        for apk in [debug, tests]: command(adb + ["install", "-r", str(apk)], check=False)
        shell("am", "force-stop", PACKAGE, check=False)
        (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report.get("status", "incomplete"), "report": str(evidence / "report.json")}))


if __name__ == "__main__":
    main()
