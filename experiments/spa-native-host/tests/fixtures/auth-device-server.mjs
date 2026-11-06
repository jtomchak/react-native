// Owned local test harness, not an application route or deployment mode.
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {startTestIdentityProvider} from './oidc-provider.mjs';
import {hostedEntry, standaloneRoot} from '../../tooling/hosted.mjs';
const directory = await mkdtemp(path.join(os.tmpdir(), 'spa-device-auth-'));
const issuer = await startTestIdentityProvider({port: 18804, hostname: '127.0.0.1'});
const config = path.join(directory, 'server.json');
await writeFile(config, JSON.stringify({origin: 'http://127.0.0.1:18803', development: true, databasePath: path.join(directory, 'auth.sqlite'), providers: {test: {issuer: issuer.origin, clientId: 'native-host-test'}}, rpId: null, passkeyOrigins: []}));
const server = spawn(process.execPath, [hostedEntry], {cwd: standaloneRoot, env: {...process.env, SPA_AUTH_CONFIG_FILE: config, HOSTNAME: '127.0.0.1', PORT: '18803', NODE_ENV: 'production'}, stdio: 'inherit'});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  if (server.exitCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; }
  await issuer.close(); await rm(directory, {recursive: true, force: true});
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await stop(); process.exit(0); });
server.once('exit', async () => { if (!stopping) { await stop(); process.exitCode = 1; } });
