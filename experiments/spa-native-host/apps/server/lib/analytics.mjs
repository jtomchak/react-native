import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {policy, object, integer} from '../../../packages/analytics-core/index.mjs';
import {RecordingCollector} from '../../../packages/analytics-core/collector.mjs';

const loops = ['localhost', '127.0.0.1', '[::1]'];
export function enabled(request) {
  // Deliberate local-only acceptance harness. Production requires its own
  // authenticated collector and control plane; never silently expose this one.
  return process.env.SPA_ANALYTICS_DEV === '1' && loops.includes(new URL(request.url).hostname) && !!process.env.SPA_ANALYTICS_POLICY_FILE && !!process.env.SPA_ANALYTICS_JOURNAL;
}
export async function currentPolicy(now = Date.now()) {
  const bytes = await readFile(process.env.SPA_ANALYTICS_POLICY_FILE);
  if (bytes.length > 65536) throw new Error('Policy too large');
  const input = JSON.parse(bytes.toString('utf8'));
  const keys = ['schemaVersion', 'revision', 'enabled', 'categories', 'names', 'properties', 'sampleBasisPoints', 'lookbackSeconds', 'destinations', 'expiresInSeconds'];
  object(input, keys); integer(input.expiresInSeconds, 1, 86400);
  const {expiresInSeconds, ...selection} = input;
  return policy({...selection, expiresAtMs: now + expiresInSeconds * 1000}, {now, destinations: ['recording']});
}
export async function readBatch(request) {
  const announced = request.headers.get('content-length');
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > 262144)) throw new Error('Batch too large');
  if (!request.body) throw new Error('Missing batch');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 262144) throw new Error('Batch too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function collector() {
  const directory = path.resolve(process.env.SPA_ANALYTICS_JOURNAL);
  const key = Symbol.for('spa.analytics.local.collectors');
  const instances = globalThis[key] ??= new Map();
  if (!instances.has(directory)) instances.set(directory, new RecordingCollector(directory));
  return instances.get(directory);
}
export const headers = {'Cache-Control': 'no-store', 'Content-Type': 'application/json'};
