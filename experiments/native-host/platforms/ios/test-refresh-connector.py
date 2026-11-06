#!/usr/bin/env python3
"""No-device regression for owned connector process groups and FIFO rejection."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

FILE = Path(__file__).resolve().parents[2] / "scripts/connect-refresh-ios.py"
SPEC = importlib.util.spec_from_file_location("ios_refresh_connector", FILE)
CONNECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONNECTOR)


class ConnectorTests(unittest.TestCase):
    def child_tree(self, directory):
        marker = Path(directory) / "orphan-marker"
        grandchild = f"import time,pathlib;time.sleep(1.2);pathlib.Path({str(marker)!r}).write_text('orphan')"
        parent = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{grandchild!r}]);time.sleep(30)"
        return [sys.executable, "-c", parent], marker

    def test_timeout_kills_descendant_inheriting_output(self):
        with tempfile.TemporaryDirectory() as directory:
            command, marker = self.child_tree(directory)
            started = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                CONNECTOR.call(command, timeout=0.15)
            self.assertLess(time.monotonic() - started, 2.5)
            time.sleep(1.3)
            self.assertFalse(marker.exists())

    def test_interrupt_kills_descendant_inheriting_output(self):
        with tempfile.TemporaryDirectory() as directory:
            command, marker = self.child_tree(directory)
            def interrupted(number, frame):
                raise CONNECTOR.ConnectorInterrupted("test interrupt")
            previous = signal.signal(signal.SIGTERM, interrupted)
            timer = threading.Timer(0.15, lambda: os.kill(os.getpid(), signal.SIGTERM))
            try:
                timer.start()
                with self.assertRaises(CONNECTOR.ConnectorInterrupted):
                    CONNECTOR.call(command, timeout=5)
            finally:
                timer.join()
                signal.signal(signal.SIGTERM, previous)
            time.sleep(1.3)
            self.assertFalse(marker.exists())

    def test_private_config_fifo_does_not_block(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "session.json"
            os.mkfifo(file, 0o600)
            started = time.monotonic()
            with self.assertRaises(ValueError):
                CONNECTOR.private_json(file)
            self.assertLess(time.monotonic() - started, 0.5)

    def test_stale_prepared_receipt_cannot_override_fresh_error(self):
        receipts = iter([
            {"revision": "123", "action": "prepare-revision", "processId": 10, "status": "prepared"},
            {"revision": "123", "action": "prepare-revision", "processId": 11, "status": "error"},
        ])
        actual = CONNECTOR.wait_for_receipt(lambda: next(receipts), "revision", "123", 11, "prepare-revision", timeout=1)
        self.assertEqual(actual["status"], "error")

    def test_stale_disconnect_and_wrong_action_are_not_accepted(self):
        receipts = iter([
            {"sessionId": "a", "action": "end-session", "processId": 10, "status": "disconnected"},
            {"sessionId": "a", "action": "other", "processId": 11, "status": "disconnected"},
            {"sessionId": "a", "action": "end-session", "processId": 11, "status": "error"},
        ])
        actual = CONNECTOR.wait_for_receipt(lambda: next(receipts), "sessionId", "a", 11, "end-session", timeout=1)
        self.assertEqual(actual["status"], "error")

    def test_rollback_forward_is_killed_if_it_ignores_term(self):
        child = subprocess.Popen([sys.executable, "-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(30)"],
                                 stdout=subprocess.PIPE, start_new_session=True)
        self.assertEqual(child.stdout.readline().strip(), b"ready")
        with self.assertRaisesRegex(RuntimeError, "forced rollback"):
            CONNECTOR.finish_owned_forward(child)
        self.assertEqual(child.returncode, -signal.SIGKILL)
        child.stdout.close()


if __name__ == "__main__":
    unittest.main()
