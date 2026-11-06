#!/usr/bin/env python3
"""Stage an immutable development revision and restart the real Android host.

Uses adb/run-as only. It never builds native code or evaluates code in a live VM.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import shlex
import subprocess

PACKAGE = "dev.nativehost.experiment"


def checked_artifact(directory, name, size, digest):
    path = directory / name
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Missing or symlinked artifact: {name}")
    if type(size) is not int or not 0 < size <= 64 * 1024 * 1024:
        raise ValueError(f"Invalid byteLength: {name}")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError(f"Invalid SHA256: {name}")
    data = path.read_bytes()
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"Artifact digest/size mismatch: {name}")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision_directory", type=Path)
    parser.add_argument("--serial", required=True, help="Explicit adb device serial")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--stage-only", action="store_true")
    args = parser.parse_args()
    directory = args.revision_directory.resolve()
    revision = directory.name
    if not re.fullmatch(r"[0-9]{1,96}", revision):
        parser.error("Revision directory must have a 1-96 digit name")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 65536:
        parser.error("Invalid manifest file")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1 or manifest.get("revision") != revision or manifest.get("mode") != "development" or manifest.get("reload") != "full":
        parser.error("Manifest schema/mode/reload/revision mismatch")
    artifacts = {"app.bundle.js": checked_artifact(directory, "app.bundle.js", manifest.get("byteLength"), manifest.get("sha256"))}
    source_map = manifest.get("sourceMap", {})
    if source_map.get("file") != "app.bundle.js.map":
        parser.error("Invalid source map manifest")
    artifacts["app.bundle.js.map"] = checked_artifact(directory, "app.bundle.js.map", source_map.get("byteLength"), source_map.get("sha256"))
    artifacts["manifest.json"] = manifest_bytes
    adb = [args.adb, "-s", args.serial]

    def shell(command, data=None, check=True):
        return subprocess.run(adb + ["shell", command], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

    def app_shell(command, data=None):
        return shell(f"run-as {shlex.quote(PACKAGE)} sh -c {shlex.quote(command)}", data).stdout

    # run-as refuses non-debuggable release packages before any transfer.
    app_shell("test -d files || mkdir files")
    target = f"files/dev-revisions/{revision}"
    staging = f"files/dev-revisions/.staging-{revision}-{secrets.token_hex(8)}"
    existing = app_shell(f"if [ -d {target} ]; then cat {target}/manifest.json; fi")
    reused = bool(existing)
    if existing:
        if json.loads(existing) != manifest:
            raise ValueError("An immutable staged revision already exists with a different manifest")
        for name, digest in [("app.bundle.js", manifest["sha256"]), ("app.bundle.js.map", source_map["sha256"])]:
            actual = app_shell(f"sha256sum {target}/{name}").decode().split()[0]
            if actual != digest:
                raise ValueError("An existing staged revision is corrupt; publish a new revision")
    else:
        app_shell(f"mkdir -p {staging}")
        try:
            for name, data in artifacts.items():
                app_shell(f"cat > {staging}/{name}", data)
            # The final digits-only directory is never observed partially written.
            app_shell(f"test ! -e {target} && mv {staging} {target}")
        except Exception:
            app_shell(f"rm -rf {staging}")
            raise
    result = {"revision": revision, "sha256": manifest["sha256"], "byteLength": manifest["byteLength"], "serial": args.serial, "package": PACKAGE, "reusedImmutableRevision": reused, "nativeBuildPerformed": False}
    if not args.stage_only:
        before = shell(f"pidof {PACKAGE}", check=False).stdout.decode().strip()
        shutdown = shell(f"am broadcast -n {PACKAGE}/dev.nativehost.DebugReloadReceiver -a dev.nativehost.experiment.PREPARE_RELOAD").stdout.decode()
        if 'result=-1' not in shutdown:
            raise RuntimeError("Debug host did not acknowledge shutdown; refusing process restart")
        shell(f"am force-stop {PACKAGE}")
        shell(f"am start -W -n {PACKAGE}/dev.nativehost.HostActivity --es devRevision {revision}")
        result.update({"status": "staged-and-launched", "previousProcessId": before or None, "processId": shell(f"pidof {PACKAGE}", check=False).stdout.decode().strip() or None, "shutdownAcknowledgement": "host-destroyed" if "host-destroyed" in shutdown else "no-active-host"})
    else:
        result["status"] = "staged-only"
    print(json.dumps(result))


if __name__ == "__main__":
    main()
