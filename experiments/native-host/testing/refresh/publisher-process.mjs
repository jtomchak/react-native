import {spawn} from 'node:child_process';

const owners = new Set();
const signalHandlers = new Map();
function removeSignalHandlers() {
  if (owners.size) return;
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
}
function installSignalHandlers() {
  if (signalHandlers.size) return;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      // The owner groups are separate from the harness group. Kill them before
      // restoring default signal behavior; do not turn Ctrl-C into a no-op.
      for (const owner of [...owners]) owner.interrupt(signal);
      owners.clear(); removeSignalHandlers();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      else process.exitCode = signal === 'SIGINT' ? 130 : 143;
    };
    signalHandlers.set(signal, handler); process.on(signal, handler);
  }
}

/**
 * Own one POSIX publisher process group. Callers keep stdout/stderr parsing.
 * `closed` resolves only on the real ChildProcess close event. `stop()` is the
 * bounded, verdict-producing cleanup API: every forced/abnormal stop rejects.
 */
export function startOwnedPublisher(args, {
  cwd, env = process.env, executable = process.execPath,
  graceMs = 3000, termMs = 1000, killMs = 1000,
  onFailure = () => {}, handleSignals = true,
} = {}) {
  if (process.platform === 'win32') throw new Error('Publisher process-group ownership requires a POSIX host');
  for (const [name, value] of Object.entries({graceMs, termMs, killMs})) {
    if (!Number.isInteger(value) || value < 1 || value > 60000) throw new Error(`Invalid ${name}`);
  }
  const child = spawn(executable, args, {cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
  let failure, notified = false, stopping = false, forced = false, actualClose, resolveClose;
  let killTimer, stopPromise, groupFinalized = false;
  const cleanupErrors = [];
  const closed = new Promise(resolve => {resolveClose = resolve;});
  const owner = {interrupt(signal) {
    forced = true; recordFailure(new Error(`Harness interrupted by ${signal}`));
    signalGroup('SIGKILL'); clearTimeout(killTimer);
  }};
  if (handleSignals) {owners.add(owner); installSignalHandlers();}
  function retire() {groupFinalized = true; owners.delete(owner); removeSignalHandlers();}
  function recordFailure(error) {
    failure ??= error;
    if (!notified) {
      notified = true;
      try {onFailure(error);} catch (callbackError) {cleanupErrors.push(callbackError);}
    }
  }
  function signalGroup(signal) {
    if (!child.pid || groupFinalized) return;
    try {process.kill(-child.pid, signal);}
    catch (error) {if (error.code !== 'ESRCH') {cleanupErrors.push(error); recordFailure(new Error(`Cannot signal publisher group with ${signal}`));}}
  }
  function groupExists() {
    if (!child.pid || groupFinalized) return false;
    try {process.kill(-child.pid, 0); return true;}
    catch (error) {
      if (error.code === 'ESRCH') return false;
      cleanupErrors.push(error); recordFailure(new Error('Cannot inspect publisher group')); return true;
    }
  }
  function force(error) {
    recordFailure(error);
    if (forced) return;
    forced = true; signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), termMs);
  }
  child.stdin.on('error', error => force(error));
  child.on('error', error => force(error));
  child.on('exit', (code, signal) => {
    if (!stopping || code !== 0 || signal) force(new Error(`Publisher exited ${code ?? signal}${stopping ? '' : ' before cleanup'}`));
  });
  child.on('close', (code, signal) => {
    actualClose = {code, signal};
    if (code !== 0 || signal) recordFailure(new Error(`Publisher closed ${code ?? signal}`));
    // Descendants can close their pipes yet keep running. Even after a clean
    // parent exit, surviving group members invalidate cleanup.
    if (groupExists()) force(new Error('Publisher descendants survived its close event'));
    if (forced || failure) signalGroup('SIGKILL');
    clearTimeout(killTimer); retire(); resolveClose(actualClose);
  });
  async function waitClose(milliseconds) {
    if (actualClose) return true;
    let timer;
    try {return await Promise.race([closed.then(() => true), new Promise(resolve => {timer = setTimeout(() => resolve(false), milliseconds);})]);}
    finally {clearTimeout(timer);}
  }
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      if (!actualClose && !forced && !child.stdin.destroyed && !child.stdin.writableEnded) {
        try {child.stdin.end('{"method":"quit"}\n');} catch (error) {force(error);}
      }
      if (!actualClose && !forced && !await waitClose(graceMs)) force(new Error('Publisher did not close during the graceful deadline'));
      if (!actualClose && forced && !await waitClose(termMs)) signalGroup('SIGKILL');
      if (!actualClose && !await waitClose(killMs)) {
        force(new Error('Publisher close event did not arrive before the cleanup deadline'));
        signalGroup('SIGKILL'); clearTimeout(killTimer);
        // Do not leave inherited pipes or a child handle keeping the harness
        // alive after the bounded failure. `closed` remains truthful/pending.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); retire();
        cleanupErrors.push(new Error('Missing publisher close event'));
      }
      if (forced || failure) signalGroup('SIGKILL');
      clearTimeout(killTimer);
      if (failure || forced || !actualClose || actualClose.code !== 0 || actualClose.signal || cleanupErrors.length) {
        throw new AggregateError([failure || new Error('Publisher cleanup was not clean'), ...cleanupErrors], failure?.message || 'Publisher cleanup failed');
      }
      return actualClose;
    })();
    return stopPromise;
  }
  return {child, closed, stop, get failure() {return failure;}};
}
