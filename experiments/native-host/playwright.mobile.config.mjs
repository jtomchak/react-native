import {defineConfig} from '@playwright/test';
import {readFileSync} from 'node:fs';
if (!process.env.NH_DRIVER_CONFIG) throw new Error('NH_DRIVER_CONFIG must identify an authenticated live native-driver configuration; mobile tests cannot silently skip.');
const {platform} = JSON.parse(readFileSync(process.env.NH_DRIVER_CONFIG, 'utf8'));
if (!['ios', 'android'].includes(platform)) throw new Error('Native driver platform must be ios or android');
const suite = process.env.NH_MOBILE_SUITE || 'smoke';
if (!['smoke', 'commands'].includes(suite)) throw new Error('NH_MOBILE_SUITE must be smoke or commands');
export default defineConfig({
  testDir: './testing',
  outputDir: `./test-results/${platform}-${suite}-artifacts`,
  testMatch: suite === 'commands' ? '**/mobile-commands.spec.mjs' : '**/mobile.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: suite === 'commands' ? 180000 : 120000,
  reporter: [['list'], ['json', {outputFile: process.env.NH_MOBILE_REPORT || 'test-results/mobile-results.json'}]],
});
