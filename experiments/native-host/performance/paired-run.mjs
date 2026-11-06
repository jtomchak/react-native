import {performance} from 'node:perf_hooks';
import {randomBytes} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export function quantile(values, fraction) {
  if (!values.length || !values.every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('Quantiles require nonempty finite nonnegative samples');
  }
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(fraction * values.length) - 1)];
}

export function summarize(samples, expectedCount) {
  const measured = samples.filter(sample => !sample.warmup);
  const result = {};
  for (const backend of ['reference', 'candidate']) {
    const lane = measured.filter(sample => sample.backend === backend);
    const passed = lane.filter(sample => sample.status === 'passed');
    const values = passed.map(sample => sample.durationMs);
    result[backend] = {count: lane.length, passed: passed.length,
      failed: lane.length - passed.length, complete: passed.length === expectedCount,
      ...(values.length ? {medianMs: quantile(values, 0.5), p95Ms: quantile(values, 0.95),
        minMs: Math.min(...values), maxMs: Math.max(...values)} : {})};
  }
  const allPassed = samples.every(sample => sample.status === 'passed');
  const complete = allPassed && Object.values(result).every(lane => lane.complete);
  return {lanes: result, complete, acceptanceEligibleSampleCount: complete && expectedCount >= 30,
    ...(complete && result.reference.medianMs > 0 ? {
      candidateMedianReduction: 1 - result.candidate.medianMs / result.reference.medianMs,
      candidateP95Reduction: 1 - result.candidate.p95Ms / result.reference.p95Ms,
    } : {})};
}

// `measure` must write the unique revision immediately, perform the actual
// workflow, then return the exact marker observed by the external OS driver.
// Timings use one host monotonic clock, never subtract device timestamps.
export async function collectPaired({reportPath, context, measure, prepare, verify, warmups = 3, count = 30}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000 ||
      !Number.isSafeInteger(warmups) || warmups < 0 || warmups > 100) throw new Error('Invalid sample counts');
  const run = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const report = {schemaVersion: 1, run, status: 'running', startedAt: new Date().toISOString(),
    endpoint: 'host source-write invocation to exact native accessibility marker response',
    clock: 'host performance.now', expectedCount: count, warmups, context, samples: []};
  await mkdir(path.dirname(reportPath), {recursive: true});
  const save = async () => {
    const temporary = `${reportPath}.${run}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n');
    await rename(temporary, reportPath);
  };
  await save();
  try {
    for (let index = 0; index < count + warmups; index++) {
      const order = index % 2 ? ['candidate', 'reference'] : ['reference', 'candidate'];
      for (const backend of order) {
        const revision = `${run}-${index}-${backend === 'reference' ? 'r' : 'c'}`;
        const expectedMarker = `Revision: ${revision}`;
        const sample = {backend, pair: index, warmup: index < warmups, revision, expectedMarker};
        let started = performance.now();
        try {
          const request = {backend, revision, expectedMarker, warmup: sample.warmup};
          const preparation = await prepare?.(request);
          sample.preparationMs = performance.now() - started;
          started = performance.now();
          const observation = await measure({...request, preparation});
          const ended = performance.now();
          if (observation.observedMarker !== expectedMarker) throw new Error('Observer returned a stale or mismatched revision');
          if (observation.mechanism !== 'os-accessibility') throw new Error('An actual OS accessibility observation is required');
          // Post-observation state/PID checks do not inflate the latency endpoint.
          const validation = await verify?.({...request, preparation, observation});
          Object.assign(sample, {status: 'passed', durationMs: ended - started, observation, preparation, validation});
        } catch (error) {
          Object.assign(sample, {status: 'failed', durationMs: performance.now() - started,
            error: {name: error.name, message: error.message}});
          report.samples.push(sample);
          await save();
          throw error;
        }
        report.samples.push(sample);
        await save();
      }
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = summarize(report.samples, count);
    await save();
  }
  return report;
}
