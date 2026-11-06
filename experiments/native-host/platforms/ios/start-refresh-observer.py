#!/usr/bin/env python3
"""Run the independent OS observer on a physical device using the approved runner ID.

Owns its xcodebuild and USB forward. The private desktop config contains port,
devicePort, token, platform=ios, timeoutSeconds; no token is put in argv.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time

IOS = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("refresh_connector", IOS.parent.parent / "scripts/connect-refresh-ios.py")
CONNECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONNECTOR)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True)
    parser.add_argument("--team", required=True)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config = CONNECTOR.private_json(args.config)
    if config.get("platform") != "ios" or not isinstance(config.get("token"), str) or len(config["token"]) < 32:
        raise ValueError("Invalid independent observer configuration")
    for key in ["port", "devicePort"]:
        if type(config.get(key)) is not int or not 1024 <= config[key] <= 65535:
            raise ValueError("Invalid observer port")
    if type(config.get("timeoutSeconds")) is not int or not 30 <= config["timeoutSeconds"] <= 7200:
        raise ValueError("Invalid observer lifetime")
    environment = {**os.environ, "NH_OBSERVER_ENABLED": "1", "NH_OBSERVER_TOKEN": config["token"],
                   "NH_OBSERVER_PORT": str(config["devicePort"]), "NH_OBSERVER_TIMEOUT": str(config["timeoutSeconds"])}
    CONNECTOR.call(["xcodegen", "generate", "--spec", str(IOS / "refresh-observer.yml"), "--project", str(IOS)], env=environment)
    result = IOS / "artifacts" / f"refresh-observer-device-{time.time_ns()}.xcresult"
    result.parent.mkdir(parents=True, exist_ok=True)
    forward = None
    primary = None
    try:
        with args.config.with_suffix(".iproxy.log").open("xb") as log:
            forward = subprocess.Popen(["iproxy", "-u", args.device, "-s", "127.0.0.1", f"{config['port']}:{config['devicePort']}"],
                                       stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if forward.poll() is not None:
                raise RuntimeError("Independent observer forward exited before listening")
            listening = CONNECTOR.call(["lsof", "-nP", "-a", "-p", str(forward.pid), f"-iTCP:{config['port']}", "-sTCP:LISTEN", "-t"], check=False)
            if listening.stdout.decode().strip() == str(forward.pid):
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("Independent observer forward did not listen")
        # Tokens are scoped environment variables used by the generated ignored
        # scheme. Build arguments contain only the already-authorized identity.
        command = ["xcodebuild", "-project", str(IOS / "NativeRefreshObserver.xcodeproj"), "-scheme", "NativeRefreshObserver",
                   "-configuration", "Debug", "-destination", f"platform=iOS,id={args.device}",
                   "-derivedDataPath", str(IOS / "build-device/refresh-observer"), "-resultBundlePath", str(result),
                   "-only-testing:NativeHostUITests/ObserverTests", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_STYLE=Automatic",
                   f"DEVELOPMENT_TEAM={args.team}", "test"]
        # Preserve live build/test log output while retaining process ownership.
        child = subprocess.Popen(command, env=environment, start_new_session=True)
        try:
            code = child.wait(timeout=config["timeoutSeconds"] + 300)
        except BaseException:
            CONNECTOR.finish_owned_forward(child)
            raise
        if code:
            raise RuntimeError(f"Independent observer xcodebuild exited {code}; result: {result}")
        summary = json.loads(CONNECTOR.call(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(result)]).stdout)
        if summary.get("totalTestCount") != 1 or summary.get("passedTests") != 1:
            raise RuntimeError("Independent observer did not execute and close successfully")
        print(json.dumps({"status": "passed", "result": str(result), "runnerBundleId": "dev.nativehost.prototype.uitests.xctrunner"}))
    except BaseException as error:
        primary = error
        raise
    finally:
        if forward is not None:
            try:
                CONNECTOR.finish_owned_forward(forward)
            except Exception as cleanup:
                if primary:
                    raise BaseExceptionGroup("Observer failed and forward cleanup failed", [primary, cleanup])
                raise


if __name__ == "__main__":
    def interrupted(number, frame):
        raise CONNECTOR.ConnectorInterrupted("Independent observer interrupted")
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    main()
