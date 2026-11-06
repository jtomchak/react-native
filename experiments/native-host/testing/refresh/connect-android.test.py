"""Rollback fault tests; mocks adb, never contacts a device."""
import importlib.util
import json
from pathlib import Path
import subprocess
import os
import signal
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/connect-refresh-android.py"
spec = importlib.util.spec_from_file_location("refresh_connect", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RollbackTests(unittest.TestCase):
    def test_permission_error_is_ignored_only_for_proven_disappeared_group(self):
        with patch.object(module.os, "killpg", side_effect=[PermissionError(), ProcessLookupError()]):
            module.signal_owned_group(123, signal.SIGKILL)
        with patch.object(module.os, "killpg", side_effect=[PermissionError(), None]):
            with self.assertRaises(PermissionError):
                module.signal_owned_group(123, signal.SIGKILL)
        with patch.object(module.os, "killpg", side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                module.signal_owned_group(123, signal.SIGKILL)

    def exercise(self, cleanup_fails):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            revision = root / "123"
            revision.mkdir()
            config = {"schemaVersion": 1, "token": "02" * 32, "sessionId": "01" * 16,
                      "initialRevision": "123", "initialBundleSha256": "03" * 32, "port": 0}
            session = root / "session.json"
            session.write_text(json.dumps(config))
            session.chmod(0o600)
            (revision / "manifest.json").write_text(json.dumps({"sha256": config["initialBundleSha256"]}))
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                command = args[-1]
                if "umask 077" in command:
                    raise subprocess.TimeoutExpired("device-config-write", 30)
                if "cat files/native-dev-session.json" in command:
                    return SimpleNamespace(returncode=0, stdout=json.dumps(config).encode())
                if cleanup_fails and "rm files/native-dev-session.json" in command:
                    raise subprocess.CalledProcessError(1, "remove-opt-in")
                return SimpleNamespace(returncode=0, stdout=b"")

            argv = [str(SCRIPT), "--serial", "mock-device", "--session", str(session),
                    "--revision-directory", str(revision), "--output", str(root / "desktop.json")]
            expected = ExceptionGroup if cleanup_fails else subprocess.TimeoutExpired
            with patch.object(sys, "argv", argv), patch.object(module.subprocess, "run", fake_run), patch.object(module, "run_deployment", return_value=b""):
                with self.assertRaises(expected) as raised:
                    module.main()
            commands = [args[-1] for args in calls]
            self.assertTrue(any("rm files/native-dev-session.json" in value for value in commands))
            self.assertTrue(any("rm -f files/.native-dev-session-" in value for value in commands))
            if cleanup_fails:
                self.assertEqual(len(raised.exception.exceptions), 2)
                self.assertIsInstance(raised.exception.exceptions[0], subprocess.TimeoutExpired)
            self.assertFalse((root / "desktop.json").exists())

    def test_config_write_timeout_still_removes_owned_opt_in_and_staging(self):
        self.exercise(False)

    def test_one_cleanup_failure_does_not_skip_remaining_cleanup_or_primary_error(self):
        self.exercise(True)

    def test_deployment_timeout_stops_real_descendant(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "late-write"
            ready = Path(temporary) / "ready"
            child = f"import time;from pathlib import Path;Path({str(ready)!r}).write_text('ready');time.sleep(0.6);Path({str(marker)!r}).write_text('leaked')"
            parent = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child!r}]);time.sleep(10)"
            with self.assertRaises(subprocess.TimeoutExpired):
                module.run_deployment([sys.executable, "-c", parent], timeout=0.3)
            self.assertTrue(ready.exists(), "descendant must actually start before the timeout")
            time.sleep(0.7)
            self.assertFalse(marker.exists(), "timed-out deployment must not leave adb-like descendants")

    def test_sigterm_interrupts_selector_wait_and_stops_real_descendant(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker, ready = Path(temporary) / "late-write", Path(temporary) / "ready"
            child = f"import time;from pathlib import Path;Path({str(ready)!r}).write_text('ready');time.sleep(1);Path({str(marker)!r}).write_text('leaked')"
            parent = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child!r}]);time.sleep(30)"
            wrapper = f"import importlib.util,sys;s=importlib.util.spec_from_file_location('helper',{str(SCRIPT)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.run_deployment([sys.executable,'-c',{parent!r}],timeout=30)"
            process = subprocess.Popen([sys.executable, "-c", wrapper], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists())
                os.kill(process.pid, signal.SIGTERM)
                _, stderr = process.communicate(timeout=3)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(b"DeploymentInterrupted", stderr)
                time.sleep(1.1)
                self.assertFalse(marker.exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()
