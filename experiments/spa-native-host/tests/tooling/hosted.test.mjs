import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hostedPort} from '../../tooling/hosted.mjs';

test('hosted server binds one explicit nonprivileged port and rejects accidental argument passthrough', () => {
  assert.equal(hostedPort(), 18797);
  assert.equal(hostedPort(['--port', '18800']), 18800);
  for (const args of [['--hostname', '0.0.0.0'], ['--port', '0'], ['--port', '80'], ['--port', '65536'], ['--port', 'NaN'], ['--port'], ['--port', '18800', 'extra']]) assert.throws(() => hostedPort(args));
});
