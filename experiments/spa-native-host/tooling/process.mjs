import {spawn} from 'node:child_process';
import {constants} from 'node:os';

export class ProcessFailure extends Error {
  constructor(message, {code = 1, signal = null, cause} = {}) {
    super(message, {cause});
    this.name = 'ProcessFailure';
    this.signal = signal;
    this.exitCode = signal ? 128 + (constants.signals[signal] || 0) : code || 1;
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Own only the detached POSIX group created by this invocation. */
export async function runOwnedProcess(command, args, {
  cwd, env = process.env, stdio = 'inherit', signal,
  graceMs = 3000, termMs = 1000, killMs = 1000, handleSignals = true,
} = {}) {
  if (process.platform === 'win32') throw new Error('Native host commands require POSIX process-group ownership');
  for (const [name, value] of Object.entries({graceMs, termMs, killMs})) {
    if (!Number.isInteger(value) || value < 1 || value > 60000) throw new Error(`Invalid ${name}`);
  }
  if (signal?.aborted) throw new ProcessFailure('Command cancelled before launch', {signal: 'SIGTERM'});
  const child = spawn(command, args, {cwd, env, stdio, detached: true});
  let result, spawnError, interrupted, stopping, retired = false;
  let rejectStop;
  const stopFailed = new Promise((_, reject) => { rejectStop = reject; });
  // The failure promise participates in the race immediately below.
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, childSignal) => { result = {code, signal: childSignal}; resolve(result); });
  });
  function groupExists() {
    if (!child.pid || retired) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  }
  async function probeGroup(milliseconds = killMs) {
    const deadline = Date.now() + milliseconds;
    while (true) {
      try { return groupExists(); }
      catch (error) {
        // macOS may report EPERM for a dying orphan group on consecutive
        // probes. It is never evidence of successful cleanup. Retry within the
        // deadline, accepting absence only after a fresh ESRCH; persistent
        // permission failures still reject.
        if (error.code !== 'EPERM' || Date.now() >= deadline) throw error;
        await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
      }
    }
  }
  async function send(groupSignal) {
    if (!child.pid || retired) return;
    try { process.kill(-child.pid, groupSignal); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      if (error.code === 'EPERM' && !await probeGroup()) return;
      throw error;
    }
  }
  async function waitClosed(milliseconds) {
    if (result) return true;
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  async function waitGroup(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (await probeGroup(Math.max(1, deadline - Date.now()))) {
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    return true;
  }
  function stop(stopSignal) {
    if (stopping) return;
    interrupted = stopSignal;
    stopping = (async () => {
      await send(stopSignal);
      if (!await waitClosed(graceMs)) {
        await send('SIGTERM');
        if (!await waitClosed(termMs)) {
          await send('SIGKILL');
          if (!await waitClosed(killMs)) throw new Error('Command did not close after SIGKILL');
        }
      }
    })();
    stopping.catch(error => rejectStop(error));
  }
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  if (handleSignals) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  signal?.addEventListener('abort', terminate, {once: true});
  // Covers cancellation between the initial check and listener registration.
  if (signal?.aborted) terminate();
  try {
    await Promise.race([closed, stopFailed]);
    if (stopping) await stopping;
    let descendants = false;
    if (await probeGroup()) {
      descendants = true;
      await send('SIGTERM');
      if (!await waitGroup(termMs)) {
        await send('SIGKILL');
        if (!await waitGroup(killMs)) throw new Error('Command process group survived SIGKILL');
      }
    }
    if (spawnError) throw spawnError;
    if (interrupted) throw new ProcessFailure(`Command interrupted by ${interrupted}`, {signal: interrupted});
    if (result.code !== 0 || result.signal) throw new ProcessFailure(`Command exited ${result.code ?? result.signal}`, result);
    if (descendants) throw new ProcessFailure('Command left descendants running; owned group was cleaned up');
    return result;
  } catch (error) {
    try { await send('SIGKILL'); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Command failed and group cleanup could not be completed'); }
    if (!result) child.unref();
    throw error;
  } finally {
    retired = true;
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    signal?.removeEventListener('abort', terminate);
  }
}
