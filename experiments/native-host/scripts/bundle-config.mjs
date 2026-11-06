import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const prototypeRoot = fileURLToPath(new URL('../', import.meta.url));

// Both one-shot and watch builds must use the same compiler/runtime contract.
export function bundleConfig({
  root = prototypeRoot,
  entry = 'js/entry.jsx',
  outputFile = path.join(root, 'build', 'app.bundle.js'),
  release = false,
  plugins = [],
} = {}) {
  return {
    cwd: root,
    input: path.resolve(root, entry),
    platform: 'neutral',
    transform: {define: {
      'process.env.NODE_ENV': JSON.stringify(release ? 'production' : 'development'),
      __NH_TEST_HOOKS__: String(!release),
    }},
    plugins,
    output: {file: outputFile, format: 'iife', sourcemap: true},
  };
}
