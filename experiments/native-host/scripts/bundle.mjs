import {build} from 'rolldown';
import {mkdir} from 'node:fs/promises';
import {bundleConfig} from './bundle-config.mjs';

await mkdir(new URL('../build/', import.meta.url), {recursive: true});
const release = process.argv.includes('--release');
await build(bundleConfig({
  release,
  outputFile: new URL(release ? '../build/app.release.bundle.js' : '../build/app.bundle.js', import.meta.url).pathname,
}));
console.log('Bundled React prototype for embedded Hermes.');
