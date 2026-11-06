import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './paths.mjs';
import {hostedOrigin, validateConfiguration} from './configuration.mjs';
import {loadSelectedPlugins} from './plugins.mjs';

const file = path.join(root, 'configuration/host-config.json');
const pluginFile = path.join(root, 'configuration/plugins.json');
try {
  const config = JSON.parse(await readFile(file, 'utf8'));
  const declaration = JSON.parse(await readFile(pluginFile, 'utf8'));
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--origin') config.content.origin = hostedOrigin(value);
    else if (key === '--content') config.content.mode = value;
    else if (key === '--navigation') config.navigation.mode = value;
    else if (key === '--chrome') config.chrome.mode = value;
    else if (key === '--analytics-origin') config.analytics.origin = value === 'none' ? null : hostedOrigin(value);
    else if (key.startsWith('--auth-')) {
      const auth = declaration.plugins.find(plugin => plugin.package === '@nativehost/auth')?.configuration;
      if (!auth) throw new Error('Select @nativehost/auth in configuration/plugins.json first');
      if (key === '--auth-origin') { auth.origin = value === 'none' ? null : hostedOrigin(value); auth.enabled = value !== 'none'; }
      else if (key === '--auth-providers') auth.providers = value === 'none' ? [] : value.split(',');
      else if (key === '--auth-rp') auth.rpId = value === 'none' ? null : value;
      else throw new Error(`Unknown configuration option: ${key}`);
    } else throw new Error(`Unknown configuration option: ${key}`);
  }
  const plugins = loadSelectedPlugins({declaration});
  config.plugins = {};
  validateConfiguration(config, {plugins});
  // Generated public settings belong in bundled output, never a second source.
  config.plugins = {};
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(pluginFile, `${JSON.stringify(declaration, null, 2)}\n`);
  console.log(`Configured ${config.content.mode} content, ${config.navigation.mode} navigation, ${config.chrome.mode} chrome. Re-export/sync and rebuild the native apps.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
