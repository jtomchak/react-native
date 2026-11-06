import {readFile, mkdir, open, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {policy, object} from '../packages/analytics-core/index.mjs';

async function writePolicyFile(file, changes, now) {
  object(changes, ['enabled', 'categories', 'names', 'properties', 'sampleBasisPoints', 'lookbackSeconds', 'destinations', 'expiresInSeconds'], []);
  let current;
  try { current = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = {schemaVersion: 1, revision: 0, enabled: false, categories: ['lifecycle', 'navigation', 'bridge', 'interaction', 'custom'], names: ['*'], properties: {}, sampleBasisPoints: 10000, lookbackSeconds: 604800, destinations: ['recording'], expiresInSeconds: 300};
  }
  const next = {...current, ...changes, revision: current.revision + 1};
  const {expiresInSeconds, ...selection} = next;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 86400) throw new Error('Invalid policy lifetime');
  policy({...selection, expiresAtMs: now + expiresInSeconds * 1000}, {now, destinations: ['recording']});
  const target = path.resolve(file), directory = path.dirname(target);
  await mkdir(directory, {recursive: true});
  const temporary = path.join(directory, '.analytics-policy-' + randomUUID());
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return next;
}

export async function updatePolicyFile(file, changes, now = Date.now()) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), {recursive: true});
  let lock;
  try { lock = await open(target + '.lock', 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Analytics policy writer is busy; retry after it exits. A crash lock must be removed only after its recorded PID is confirmed stopped.'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({pid: process.pid}) + '\n');
    return await writePolicyFile(target, changes, now);
  } finally { await lock.close(); await unlink(target + '.lock'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let file; const changes = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (value === undefined) throw new Error('Each flag requires a value');
      if (key === '--file') file = value;
      else if (key === '--enabled') { if (!['true', 'false'].includes(value)) throw new Error('Enabled must be true or false'); changes.enabled = value === 'true'; }
      else if (key === '--names' || key === '--categories') changes[key.slice(2)] = value ? value.split(',') : [];
      else if (key === '--properties') changes.properties = JSON.parse(value);
      else if (key === '--sample') changes.sampleBasisPoints = Number(value);
      else if (key === '--lookback') changes.lookbackSeconds = Number(value);
      else throw new Error('Unknown analytics policy option');
    }
    if (!file) throw new Error('Specify --file POLICY_FILE');
    const next = await updatePolicyFile(file, changes);
    console.log(`Analytics policy revision ${next.revision}: export ${next.enabled ? 'enabled' : 'disabled'}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
