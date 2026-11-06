import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

// Deliberately has no native-ack dependency: both backends end at the same OS
// observation. Slow acknowledgments belong in post-observation validation.
export async function observeSourceEdit({write, waitForMarker, expectedMarker, packageName, now = () => performance.now()}) {
  const writeInvokedAtMs = now();
  await write();
  const sourceWrittenAtMs = now();
  const observed = await waitForMarker();
  const markerObservedAtMs = now();
  assert.equal(observed.exists, true, 'OS marker missing');
  assert.equal(observed.visible, true, 'OS marker hidden');
  assert.equal(observed.package, packageName, 'OS marker belongs to another application');
  assert.equal(observed.text, expectedMarker, 'OS returned a stale marker');
  return {observedMarker: observed.text, mechanism: 'os-accessibility', observed,
    writeInvokedAtMs, sourceWrittenAtMs, markerObservedAtMs,
    sourceWriteToMarkerMs: markerObservedAtMs - writeInvokedAtMs};
}

export function validateTerminal({ticket, terminal, applied, generation, sequence, baseRevision}) {
  assert.equal(ticket.sequence, sequence, 'Unexpected patch sequence');
  assert.equal(ticket.baseRevision, baseRevision, 'Unexpected patch base');
  assert.match(ticket.payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(ticket.targetRevision, /^[0-9]{1,64}$/);
  assert.equal(terminal.event, 'patch.terminal');
  const result = terminal.result;
  for (const name of ['sequence', 'baseRevision', 'targetRevision', 'payloadSha256']) assert.equal(result[name], ticket[name], `Terminal ${name} mismatch`);
  assert.equal(result.generation, generation);
  assert.equal(result.status, 'applied');
  assert.equal(result.phase, 'mount-submitted');
  assert.equal(result.reloadRequired, false);
  assert.equal(result.appliedRevision, ticket.targetRevision);
  assert.equal(applied.generation, generation);
  assert.equal(applied.sequence, sequence);
  assert.equal(applied.revision, ticket.targetRevision);
  return result;
}
