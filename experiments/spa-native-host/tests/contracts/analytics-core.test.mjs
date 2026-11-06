import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {event, policy, matches, sampleBucket, policySelectors} from '../../packages/analytics-core/index.mjs';
import {RecordingCollector} from '../../packages/analytics-core/collector.mjs';
import {posthogRequest, mixpanelRequest, ga4Requests, AnalyticsAdapters} from '../../packages/analytics-core/adapters.mjs';

const now = 1800000000000;
const makeEvent = (extra = {}) => ({schemaVersion: 1, id: randomUUID(), installId: randomUUID(), sessionId: randomUUID(), timeMs: now - 1000, platform: 'ios', source: 'native', category: 'bridge', name: 'bridge.completed', properties: {action: 'storage.set', outcome: 'ok'}, ...extra});
const makePolicy = (extra = {}) => ({schemaVersion: 1, revision: 1, expiresAtMs: now + 60000, enabled: true, categories: ['bridge'], names: ['*'], properties: {}, sampleBasisPoints: 10000, lookbackSeconds: 604800, destinations: ['recording'], ...extra});

test('analytics events admit only semantic fields and native envelope identity', () => {
  assert.equal(event(makeEvent(), now).properties.action, 'storage.set');
  for (const extra of [{properties: {value: 'secret'}}, {properties: {control: 'person@example.com'}}, {properties: {screen: '/hosted/customer/42?token=secret'}}, {properties: {durationMs: true}}, {args: {key: 'private'}}, {source: 'web', category: 'lifecycle'}, {timeMs: now + 999999}]) assert.throws(() => event(makeEvent(extra), now));
});
test('remote selection can select retained historical data without expanding capture fields', () => {
  const old = makeEvent({timeMs: now - 3600000});
  assert.equal(matches(old, policy(makePolicy({properties: {outcome: 'error'}}), {now}), now), false);
  assert.equal(matches(old, policy(makePolicy({revision: 2, properties: {outcome: 'ok'}}), {now}), now), true);
  assert.equal(matches(old, makePolicy({lookbackSeconds: 60}), now), false);
  assert.equal(matches(old, makePolicy({enabled: false}), now), false);
  assert.equal(matches(old, makePolicy({expiresAtMs: now}), now), false);
  assert.equal(matches(old, makePolicy({sampleBasisPoints: 0}), now), false);
  for (const extra of [{properties: {url: 'https://private'}}, {destinations: ['foreign']}, {endpoint: 'https://foreign'}, {expiresAtMs: now - 1}, {expiresAtMs: now + 86400001}, {sampleBasisPoints: 1.5}]) assert.throws(() => policy(makePolicy(extra), {now}));
  assert.equal(policySelectors(makePolicy()), policySelectors(makePolicy({expiresAtMs: now + 99999})));
  assert.notEqual(policySelectors(makePolicy()), policySelectors(makePolicy({properties: {outcome: 'error'}})));
});
test('sampling is deterministic across fixed UUIDs', () => {
  assert.equal(sampleBucket('00000000-0000-4000-8000-000000000001'), 9522);
});
test('collector ACK follows durable publication; retry after process recreation deduplicates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-analytics-'));
  try {
    const item = makeEvent(), input = {schemaVersion: 1, destination: 'recording', policyRevision: 1, events: [item]};
    const first = new RecordingCollector(root);
    assert.deepEqual((await first.accept(input, makePolicy(), now)).accepted, [item.id]);
    const restarted = new RecordingCollector(root);
    const reordered = {...item, properties: {outcome: 'ok', action: 'storage.set'}};
    assert.deepEqual((await restarted.accept({...input, events: [reordered]}, makePolicy(), now)).accepted, [item.id]);
    assert.equal((await readdir(root)).length, 1);
    const recorded = JSON.parse(await readFile(path.join(root, (await readdir(root))[0]), 'utf8'));
    assert.equal(recorded.event.id, item.id);
    await assert.rejects(restarted.accept({...input, events: [{...item, name: 'bridge.other'}]}, makePolicy(), now), /collision/);
    await assert.rejects(restarted.accept(input, makePolicy({revision: 2}), now), /policy/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
test('collector honestly ACKs only published records under bounds and interrupted writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-analytics-'));
  try {
    const items = [makeEvent(), makeEvent()];
    const input = {schemaVersion: 1, destination: 'recording', policyRevision: 1, events: items};
    const limited = new RecordingCollector(root, {maxRecords: 1});
    assert.deepEqual((await limited.accept(input, makePolicy(), now)).accepted, [items[0].id]);
    const failed = new RecordingCollector(path.join(root, 'interrupted'), {beforePublish() { throw new Error('interrupted before publication'); }});
    await assert.rejects(failed.accept(input, makePolicy(), now), /interrupted/);
    assert.deepEqual(await readdir(path.join(root, 'interrupted')), []);
  } finally { await rm(root, {recursive: true, force: true}); }
});
test('provider mappings retain canonical event IDs/time and require real Firebase identity', async () => {
  const value = makeEvent();
  const ph = posthogRequest([value], {projectToken: 'fixture', now});
  assert.equal(ph.body.batch[0].uuid, value.id); assert.equal(ph.body.batch[0].timestamp, new Date(value.timeMs).toISOString());
  const mp = mixpanelRequest([value], {projectId: 'fixture', username: 'test', password: 'test', now});
  assert.equal(mp.body[0].properties.$insert_id, value.id); assert.equal(mp.body[0].properties.time, value.timeMs);
  const ga = {apiSecret: 'fixture', firebaseAppId: 'fixture', now};
  assert.throws(() => ga4Requests([value], ga), /actual SDK/);
  assert.throws(() => ga4Requests([value], {...ga, appInstanceId: () => value.installId}), /unavailable/);
  assert.throws(() => ga4Requests([{...value, timeMs: now - 73 * 3600000}], {...ga, appInstanceId: () => 'a'.repeat(32)}), /backdate/);
  assert.equal(ga4Requests([value], {...ga, appInstanceId: () => 'a'.repeat(32)})[0].body.timestamp_micros, value.timeMs * 1000);
  const adapters = new AnalyticsAdapters();
  const current = {...value, timeMs: Date.now() - 1000};
  adapters.register('fixture', {async deliver(values) { return {status: 'submitted', accepted: values.map(item => item.id)}; }});
  assert.equal((await adapters.deliver('fixture', [current])).status, 'submitted');
  adapters.register('bad', {async deliver() { return {status: 'accepted', accepted: ['forged']}; }});
  await assert.rejects(adapters.deliver('bad', [current]), /receipt/);
});

test('a hard process exit leaves staging data counted against collector bounds', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-crash-'));
  try {
    const input = {schemaVersion: 1, destination: 'recording', policyRevision: 1, events: [makeEvent()]};
    const source = `import {RecordingCollector} from ${JSON.stringify(new URL('../../packages/analytics-core/collector.mjs', import.meta.url).href)};\nawait new RecordingCollector(process.argv[1],{beforePublish(){process.exit(77)}}).accept(JSON.parse(process.argv[2]),JSON.parse(process.argv[3]),${now});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, root, JSON.stringify(input), JSON.stringify(makePolicy())]);
    assert.equal(child.status, 77);
    const files = await readdir(root);
    assert.equal(files.length, 1); assert.equal(files[0].startsWith('.pending-'), true);
    const restarted = new RecordingCollector(root, {maxRecords: 1});
    assert.deepEqual((await restarted.accept(input, makePolicy(), now)).accepted, []);
  } finally { await rm(root, {recursive: true, force: true}); }
});
