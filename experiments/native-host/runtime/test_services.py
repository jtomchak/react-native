"""Real Hermes/Rust integration checks, without Node or mocked native services."""
import argparse
import json
import subprocess
import time
import unittest
from pathlib import Path

BINARY = Path(__file__).resolve().parent.parent / 'build/headless/native-host'


class Host:
    def __init__(self):
        self.process = subprocess.Popen(
            [str(BINARY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        self.sequence = 0
        self.closed = False

    def call(self, method, params=None):
        self.sequence += 1
        self.process.stdin.write(json.dumps({
            'id': self.sequence, 'method': method, 'params': params or {},
        }) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError('native process exited: ' + self.process.stderr.read())
        response = json.loads(line)
        if 'error' in response:
            raise AssertionError(response['error'])
        return response['result']

    def evaluate(self, source):
        return self.call('runtime.eval', {'source': source})

    def wait(self, expression):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            pump = self.call('runtime.pump')
            if pump['errors']:
                raise AssertionError(pump['errors'])
            result = self.evaluate(expression)
            if result:
                return result
            time.sleep(0.002)
        raise AssertionError('condition timed out: ' + expression)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.process.stdin.close()
        self.process.wait(timeout=5)
        error = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        if self.process.returncode:
            raise AssertionError(error)


class RealServiceTests(unittest.TestCase):
    def setUp(self):
        self.host = Host()
        self.addCleanup(self.host.close)
        self.host.evaluate('globalThis.events=[];globalThis.__nhServiceEvent=e=>events.push(JSON.parse(e))')

    def test_actual_runtime_identity(self):
        identity = self.host.call('session.describe')
        self.assertEqual(identity['runtime'], 'Hermes')
        self.assertEqual(identity['serviceCore'], 'Rust')
        self.assertEqual(identity['platform'], 'headless')
        self.assertEqual(self.host.evaluate('Promise.resolve(1) instanceof Promise'), True)

    def test_async_utf8_and_nul_bytes_round_trip(self):
        self.host.evaluate('globalThis.id=__nhEcho("hello ☃\\u0000world",1)')
        self.host.wait('events.length===1')
        event = self.host.evaluate('events[0]')
        self.assertEqual(event['status'], 'success')
        self.assertEqual(event['payload'], 'hello ☃\0world')
        self.assertEqual(event['generation'], self.host.call('session.describe')['generation'])

    def test_async_native_error_crosses_runtime_boundary(self):
        self.host.evaluate('__nhTestEchoError("echo: injected failure",0)')
        self.host.wait('events.length===1')
        self.assertEqual(self.host.evaluate('events[0].status'), 'error')
        self.assertEqual(self.host.evaluate('events[0].payload'), 'echo: injected failure')

    def test_winning_cancel_delivered_once(self):
        self.assertEqual(self.host.evaluate('globalThis.id=__nhEcho("late",60000);__nhCancel(id)'), 0)
        self.host.wait('events.length===1')
        self.assertEqual(self.host.evaluate('events[0].status'), 'cancelled')
        self.host.evaluate('__nhCancel(id)')
        self.host.call('runtime.pump')
        self.assertEqual(self.host.evaluate('events.length'), 1)

    def test_subscription_unsubscribe_discards_queued_messages(self):
        self.host.evaluate('globalThis.s=__nhSubscribe();__nhPublish(s,"discard");__nhUnsubscribe(s)')
        self.host.call('runtime.pump')
        self.assertEqual(self.host.evaluate('events'), [])
        self.host.evaluate('globalThis.s=__nhSubscribe();__nhPublish(s,"deliver")')
        self.host.wait('events.length===1')
        self.assertEqual(self.host.evaluate('events[0].kind'), 'subscription')
        self.assertEqual(self.host.evaluate('events[0].payload'), 'deliver')

    def test_completion_callback_can_reenter_service(self):
        self.host.evaluate('globalThis.__nhServiceEvent=e=>{events.push(JSON.parse(e));if(events.length===1)__nhEcho("second",0)};__nhEcho("first",0)')
        self.host.wait('events.length===2')
        self.assertEqual(self.host.evaluate('events.map(e=>e.payload)'), ['first', 'second'])

    def test_promise_microtasks_and_timer_arguments(self):
        self.host.evaluate('globalThis.order=[];Promise.resolve().then(()=>order.push("microtask"));setTimeout((a,b)=>order.push(a+b),0,2,3)')
        self.host.wait('order.length===2')
        self.assertEqual(self.host.evaluate('order'), ['microtask', 5])

    def test_async_errors_persist_until_explicit_acknowledgment(self):
        self.host.evaluate('setTimeout(()=>{throw new Error("expected async failure")},0)')
        first = self.host.call('runtime.pump')
        self.assertTrue(any('expected async failure' in e for e in first['errors']))
        second = self.host.call('runtime.pump')
        self.assertEqual(second['errors'], first['errors'])
        self.assertEqual(self.host.call('runtime.ackErrors')['acknowledged'], 1)
        self.assertEqual(self.host.call('runtime.pump')['errors'], [])

    def test_shutdown_does_not_wait_for_delayed_work(self):
        self.host.evaluate('__nhEcho("never",60000)')
        start = time.monotonic()
        # Close is tested here so replace the cleanup with a no-op afterward.
        self.host.close()
        self.host.close = lambda: None
        self.assertLess(time.monotonic() - start, 2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path)
    args, unittest_args = parser.parse_known_args()
    if args.binary:
        BINARY = args.binary.resolve()
    unittest.main(argv=[__file__, *unittest_args])
