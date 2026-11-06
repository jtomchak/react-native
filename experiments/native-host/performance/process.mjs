import {spawn} from 'node:child_process';

// Each command owns a process group. Python deployment children include adb;
// stopping just Python would let transfers/restarts outlive a failed sample.
export async function runProcess(executable, args, {cwd, timeout = 60000, maxOutput = 8 * 1024 * 1024} = {}) {
  if (process.platform === 'win32') throw new Error('Owned process-group cleanup is implemented for Unix hosts only');
  const child = spawn(executable, args, {cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure, hardStop, stopping = false;
  const cleanupErrors = [];
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); }
  };
  const stop = error => {
    failure ??= error;
    if (stopping) return;
    stopping = true;
    signalGroup('SIGTERM');
    hardStop = setTimeout(() => signalGroup('SIGKILL'), 2000);
  };
  child.stdout.on('data', bytes => {
    if (stdout.length + bytes.length > maxOutput) stop(new Error('Command output exceeded limit'));
    else stdout += bytes;
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-65536); });
  const timer = setTimeout(() => stop(new Error(`Command timed out: ${executable}`)), timeout);
  try {
    const code = await new Promise(resolve => {
      child.once('error', error => { failure ??= error; });
      // close follows stdio closure, including inherited descendant pipes.
      child.once('close', resolve);
    });
    if (stopping) signalGroup('SIGKILL');
    if (failure || code !== 0 || cleanupErrors.length) {
      throw new AggregateError([failure || new Error(`${executable} exited ${code}: ${stderr}`), ...cleanupErrors],
        failure?.message || `${executable} failed: ${stderr}`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(timer);
    clearTimeout(hardStop);
  }
}
