import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

process.env.SPA_HOSTED_TEST_URL ||= 'http://127.0.0.1:18797';
export default defineConfig({
  testDir: '.',
  testMatch: 'hosted.spec.mjs',
  timeout: 30000,
  workers: 1,
  use: {headless: true, baseURL: process.env.SPA_HOSTED_TEST_URL},
  reporter: [['list'], ['json', {outputFile: fileURLToPath(new URL('../../evidence/hosted-browser-results.json', import.meta.url))}]],
});
