import {createRequire} from 'node:module';
import {root, webRoot, serverRoot} from './paths.mjs';
import {preparePublic, sync} from './sync.mjs';
import {runOwnedProcess} from './process.mjs';
import {stageHosted, hostedEntry, hostedPort} from './hosted.mjs';

const require = createRequire(import.meta.url);
async function run(command, args, options = {}) {
  return runOwnedProcess(command, args, {cwd: root, stdio: 'inherit', ...options});
}

try {
  const command = process.argv[2];
  if (command === 'export') {
    await preparePublic();
    await run(process.execPath, [require.resolve('next/dist/bin/next'), 'build', webRoot], {env: {...process.env, NEXT_TELEMETRY_DISABLED: '1'}});
    const receipt = await sync();
    console.log(`Staged ${Object.keys(receipt.assets).length} hashed web assets.`);
  } else if (command === 'sync') {
    const receipt = await sync();
    console.log(`Staged ${Object.keys(receipt.assets).length} hashed web assets.`);
  } else if (command === 'build-hosted') {
    await preparePublic(serverRoot);
    await run(process.execPath, [require.resolve('next/dist/bin/next'), 'build', serverRoot], {env: {...process.env, NEXT_TELEMETRY_DISABLED: '1'}});
    const receipt = await stageHosted();
    console.log(`Staged production Next server (${Object.keys(receipt.static.assets).length} static assets). Packaged export preserved.`);
  } else if (command === 'start-hosted') {
    const port = hostedPort(process.argv.slice(3));
    // This command exposes only an owned loopback test server. Deployment entry
    // defaults to Secure cookies; explicit local HTTP tests need this override.
    await run(process.execPath, [hostedEntry], {env: {...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), SPA_SECURE_COOKIES: '0', NEXT_TELEMETRY_DISABLED: '1'}});
  } else if (command === 'dev-hosted') {
    await preparePublic(serverRoot);
    await run(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', serverRoot, '--hostname', '0.0.0.0', ...process.argv.slice(3)], {env: {...process.env, NEXT_TELEMETRY_DISABLED: '1'}});
  } else if (command === 'dev') {
    await preparePublic();
    await run(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', webRoot, '--hostname', '0.0.0.0', ...process.argv.slice(3)], {env: {...process.env, NEXT_TELEMETRY_DISABLED: '1'}});
  } else if (command === 'build-ios' || command === 'build-android') {
    await sync();
    await run('bash', [`hosts/${command === 'build-ios' ? 'ios' : 'android'}/build.sh`, ...process.argv.slice(3)]);
  } else throw new Error('Usage: node tooling/cli.mjs export|sync|dev|build-hosted|start-hosted|dev-hosted|build-ios|build-android');
} catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
