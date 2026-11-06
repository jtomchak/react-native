import {mkdir, readdir, lstat, readFile, open, link, unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {batch, policy, matches, digest} from './index.mjs';

// Prototype local collector: immutable, fsynced per-event journal records. The
// atomic hard-link publishes only a complete record; retries never replace it.
export class RecordingCollector {
  #tail = Promise.resolve();
  #pending = 0;
  constructor(directory, {maxRecords = 10000, maxBytes = 16777216, beforePublish} = {}) {
    this.directory = path.resolve(directory); this.maxRecords = maxRecords; this.maxBytes = maxBytes; this.beforePublish = beforePublish;
  }
  accept(value, selection, now = Date.now()) {
    if (this.#pending >= 16) return Promise.reject(new Error('Collector busy'));
    this.#pending++;
    const run = this.#tail.then(() => this.#accept(value, selection, now));
    this.#tail = run.catch(() => {});
    return run.finally(() => { this.#pending--; });
  }
  async #accept(value, selection, now) {
    batch(value, {now, destinations: ['recording']}); policy(selection, {now, destinations: ['recording']});
    if (!selection.enabled || value.policyRevision !== selection.revision || !selection.destinations.includes(value.destination) || value.events.some(item => !matches(item, selection, now))) throw new Error('Upload policy changed or batch does not match');
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    // Crash-abandoned staging files consume the same quota as published files.
    // Never ignore their bytes or delete an in-flight publisher's temporary file.
    const files = await readdir(this.directory);
    let records = files.length, bytes = 0;
    for (const file of files) {
      const entry = await lstat(path.join(this.directory, file));
      if (!entry.isFile()) throw new Error('Collector journal contains a non-regular entry');
      bytes += entry.size;
    }
    const accepted = [];
    for (const item of value.events) {
      const key = createHash('sha256').update(value.destination + ':' + item.id).digest('hex');
      const final = path.join(this.directory, key + '.json');
      const expectedHash = digest(item);
      try {
        const previous = JSON.parse(await readFile(final, 'utf8'));
        if (previous.destination !== value.destination || previous.event.id !== item.id || previous.eventHash !== expectedHash || digest(previous.event) !== expectedHash) throw new Error('Event identity collision');
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        accepted.push(item.id); continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const record = JSON.stringify({schemaVersion: 1, destination: value.destination, policyRevision: value.policyRevision, eventHash: expectedHash, event: item}) + '\n';
      const size = Buffer.byteLength(record);
      if (records >= this.maxRecords || bytes + size > this.maxBytes) break; // honest partial ACK
      const temporary = path.join(this.directory, '.pending-' + randomUUID());
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
        await this.beforePublish?.(item);
        try { await link(temporary, final); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const previous = JSON.parse(await readFile(final, 'utf8'));
          if (previous.eventHash !== expectedHash || digest(previous.event) !== expectedHash) throw new Error('Event identity collision');
        }
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        records++; bytes += size; accepted.push(item.id);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return {schemaVersion: 1, accepted};
  }
}
