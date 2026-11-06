import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rolldown} from 'rolldown';
import {transform} from 'rolldown/experimental';

// Application modules get lexical per-module hooks. No ambient current-module
// global can be corrupted when one factory synchronously initializes another.
export function nativeRefreshTransform({root, applicationDirectory = path.join(root, 'application')}) {
  return {
    name: 'native-refresh-signatures',
    async transform(source, id) {
      const relative = path.relative(applicationDirectory, id);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.[cm]?[jt]sx?$/.test(id)) return null;
      const moduleId = path.relative(root, id).split(path.sep).join('/');
      const prefix = `const __nhRefreshReg = (type, localId) => globalThis.__nhDevRegister(${JSON.stringify(moduleId)}, type, localId);\nconst __nhRefreshSig = globalThis.__nhDevSignature;\n`;
      const result = await transform(id, source, {sourcemap: true,
        jsx: {runtime: 'automatic', development: true, refresh: {refreshReg: '__nhRefreshReg', refreshSig: '__nhRefreshSig'}}});
      if (result.errors.length) throw result.errors[0];
      // The generated registrations and signatures precede module completion.
      return {code: `${prefix}${result.code}\nglobalThis.__nhDevModuleDone(${JSON.stringify(moduleId)});\n`,
        map: result.map && {...result.map, mappings: `;;${result.map.mappings}`}};
    },
  };
}

export async function buildNativeRefreshBootstrap({clientId, applicationPrefix = 'application/'}) {
  const clientPath = fileURLToPath(new URL('../js/dev/refresh-client.js', import.meta.url));
  const bundle = await rolldown({input: 'native-refresh-bootstrap', platform: 'neutral',
    transform: {define: {'process.env.NODE_ENV': '"development"'}},
    plugins: [{name: 'native-refresh-bootstrap', resolveId(id) {if (id === 'native-refresh-bootstrap') return '\0native-refresh-bootstrap';},
      load(id) {if (id === '\0native-refresh-bootstrap') return `import {installNativeRefreshRuntime} from ${JSON.stringify(clientPath)}; globalThis.__nhInstallRefreshRuntime = installNativeRefreshRuntime;`;}}]});
  try {
    const output = await bundle.generate({format: 'iife'});
    return `${output.output[0].code}\nglobalThis.__nhInstallRefreshRuntime(DevRuntime, ${JSON.stringify({clientId, applicationPrefix})});\n`;
  } finally { await bundle.close(); }
}
