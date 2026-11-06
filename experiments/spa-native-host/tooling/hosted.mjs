import {cp, lstat, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {root, serverRoot} from './paths.mjs';
import {manifest} from './sync.mjs';

export const standaloneRoot = path.join(serverRoot, '.next-server/standalone/apps/server');
export const hostedEntry = path.join(standaloneRoot, 'server.js');

export async function stageHosted() {
  await lstat(hostedEntry);
  for (const [source, destination] of [
    [path.join(serverRoot, 'public'), path.join(standaloneRoot, 'public')],
    [path.join(serverRoot, '.next-server/static'), path.join(standaloneRoot, '.next-server/static')],
  ]) {
    await manifest(source);
    await rm(destination, {recursive: true, force: true});
    await mkdir(path.dirname(destination), {recursive: true});
    await cp(source, destination, {recursive: true});
  }
  const digest = data => createHash('sha256').update(data).digest('hex');
  const serverGraph = await manifest(path.join(standaloneRoot, '.next-server/server'));
  // Next can add rendered response caches after startup. They are runtime data,
  // rather than executable build artifacts, and must not change build identity.
  const serverAssets = Object.fromEntries(Object.entries(serverGraph.assets)
    .filter(([file]) => !file.startsWith('/route-cache/')));
  const receipt = {schemaVersion: 1, mode: 'hosted', buildTime: new Date().toISOString(),
    entry: path.relative(root, hostedEntry), entrySha256: digest(await readFile(hostedEntry)),
    lockSha256: digest(await readFile(path.join(root, 'package-lock.json'))),
    serverGraph: {sha256: digest(JSON.stringify(serverAssets)), files: Object.keys(serverAssets).length},
    public: await manifest(path.join(standaloneRoot, 'public')),
    static: await manifest(path.join(standaloneRoot, '.next-server/static'))};
  await mkdir(path.join(root, 'build'), {recursive: true});
  await writeFile(path.join(root, 'build/hosted-build.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function hostedPort(args = []) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--port')) throw new Error('Usage: start-hosted [--port PORT]');
  const port = args.length ? Number(args[1]) : 18797;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid hosted port');
  return port;
}
