#!/usr/bin/env python3
"""Verify two real watcher revisions on an already installed Android native shell.

This command neither installs APKs nor invokes native or JavaScript builds.
Native UI and a debug startup receipt are observed without instrumentation
relaunching the Activity being measured.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
PACKAGE = "dev.nativehost.experiment"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--updated", type=Path, required=True)
    parser.add_argument("--base-heading", default="Native host prototype")
    parser.add_argument("--updated-heading", default="Native host reload verified")
    args = parser.parse_args()
    adb = ["adb", "-s", args.serial]
    evidence = ROOT / ".cache/watch-reload"
    evidence.mkdir(parents=True, exist_ok=True)
    report = {"kind": "real-watcher-native-reload", "nativeBuildPerformed": False, "javascriptBuildPerformed": False, "apkInstalled": False, "serial": args.serial, "observations": []}

    def command(arguments, check=True):
        return subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check, timeout=45)

    def shell(*arguments, check=True):
        return command(adb + ["shell"] + list(arguments), check=check).stdout.decode()

    def installed_hash():
        package_path = shell("pm", "path", PACKAGE).strip().removeprefix("package:")
        if not package_path.startswith("/data/app/") or "\n" in package_path:
            raise AssertionError("Expected one installed native-host base APK")
        output = shell("sha256sum " + shlex.quote(package_path))
        return output.split()[0]

    def receipt(revision, pid):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                result = json.loads(shell("run-as", PACKAGE, "cat", "files/dev-startup.json"))
                if result.get("bundleRevision") == revision and str(result.get("processId")) == str(pid):
                    assert result["healthy"] and result["runtimeStarted"] and result["runtimeGeneration"] is not None, result
                    return result
            except (ValueError, subprocess.CalledProcessError):
                pass
            time.sleep(.05)
        raise AssertionError("No matching native startup receipt")

    def native_tree(heading, count, filename):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            shell("uiautomator", "dump", "/sdcard/native-host-watch.xml", check=False)
            xml = shell("cat", "/sdcard/native-host-watch.xml", check=False)
            if xml.startswith("<?xml"):
                tree = ET.fromstring(xml)
                labels = [node.attrib.get("text") for node in tree.iter("node")]
                if heading in labels and f"Count: {count}" in labels:
                    (evidence / filename).write_text(xml)
                    return tree
            time.sleep(.1)
        raise AssertionError(f"Native UI did not show heading {heading!r} and Count: {count}")

    report["installedApkSha256Before"] = installed_hash()
    try:
        first = json.loads(command([sys.executable, str(ROOT / "deploy-revision.py"), str(args.base), "--serial", args.serial]).stdout)
        first_receipt = receipt(args.base.name, first["processId"])
        tree = native_tree(args.base_heading, 0, "base-native-ui.xml")
        button = next(node for node in tree.iter("node") if node.attrib.get("content-desc") == "Increment")
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", button.attrib["bounds"]))
        shell("input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        native_tree(args.base_heading, 1, "base-state-native-ui.xml")
        report["observations"].append({"stage": "base", "deployment": first, "nativeStartup": first_receipt, "nativeCountAfterInput": 1})
        print("PASS actual watcher base revision: native heading and Count: 1", flush=True)
        second = json.loads(command([sys.executable, str(ROOT / "deploy-revision.py"), str(args.updated), "--serial", args.serial]).stdout)
        second_receipt = receipt(args.updated.name, second["processId"])
        native_tree(args.updated_heading, 0, "updated-native-ui.xml")
        assert second["shutdownAcknowledgement"] == "host-destroyed"
        assert first_receipt["processId"] != second_receipt["processId"]
        assert first_receipt["hostSessionId"] != second_receipt["hostSessionId"]
        report["observations"].append({"stage": "updated", "deployment": second, "nativeStartup": second_receipt, "nativeCountAfterReload": 0})
        report["installedApkSha256After"] = installed_hash()
        assert report["installedApkSha256Before"] == report["installedApkSha256After"]
        report["status"] = "passed"
        print("PASS actual watcher updated revision: new native heading/PID/host session, fresh Count: 0, installed APK hash unchanged", flush=True)
    finally:
        (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "report": str(evidence / "report.json")}))


if __name__ == "__main__":
    main()
