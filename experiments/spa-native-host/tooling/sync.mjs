import {cp, mkdir, readFile, readdir, rename, rm, lstat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {root, webRoot, bundleRoot} from './paths.mjs';
import {loadConfiguration} from './configuration.mjs';
import {assembleSDK, syncPlugins} from './plugins.mjs';

export async function preparePublic(applicationRoot = webRoot) {
  syncPlugins();
  await mkdir(path.join(applicationRoot, 'public'), {recursive: true});
  await writeFile(path.join(applicationRoot, 'public/platform-sdk.js'), await assembleSDK());
  await cp(path.join(root, 'fixtures/plain-html/index.html'), path.join(applicationRoot, 'public/plain.html'));
  await cp(path.join(root, 'fixtures/injected-html/index.html'), path.join(applicationRoot, 'public/injected.html'));
}

export async function manifest(directory) {
  const assets = {};
  async function walk(relative = '') {
    for (const entry of (await readdir(path.join(directory, relative))).sort()) {
      const file = path.join(relative, entry);
      const stat = await lstat(path.join(directory, file));
      if (stat.isSymbolicLink()) throw new Error(`Symlink refused in exported assets: ${file}`);
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        const data = await readFile(path.join(directory, file));
        assets[`/${file.split(path.sep).join('/')}`] = {bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')};
      } else throw new Error(`Non-regular exported asset: ${file}`);
    }
  }
  await walk();
  return {version: 1, assets};
}

export async function sync() {
  await preparePublic();
  const out = path.join(webRoot, 'out');
  await lstat(path.join(out, 'index.html'));
  const stage = path.join(root, 'build', `web-stage-${process.pid}`);
  await mkdir(path.dirname(stage), {recursive: true});
  await rm(stage, {recursive: true, force: true});
  try {
    // Validate before copy to prevent following an exported symlink.
    await manifest(out);
    await cp(out, stage, {recursive: true});
    await cp(path.join(webRoot, 'public/platform-sdk.js'), path.join(stage, 'platform-sdk.js'));
    await cp(path.join(webRoot, 'public/plain.html'), path.join(stage, 'plain.html'));
    await cp(path.join(webRoot, 'public/injected.html'), path.join(stage, 'injected.html'));
    const configuration = await loadConfiguration(path.join(root, 'configuration/host-config.json'));
    await writeFile(path.join(stage, 'host-config.json'), `${JSON.stringify(configuration, null, 2)}\n`);
    const receipt = await manifest(stage);
    await writeFile(path.join(stage, 'asset-manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    await rm(bundleRoot, {recursive: true, force: true});
    await rename(stage, bundleRoot);
    return receipt;
  } finally { await rm(stage, {recursive: true, force: true}); }
}
