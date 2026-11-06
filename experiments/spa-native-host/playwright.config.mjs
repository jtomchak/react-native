import {defineConfig} from '@playwright/test';

export default defineConfig({
  testIgnore: ['**/auth-server.spec.mjs'],
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', {outputFile: 'evidence/browser-results.json'}]],
  use: {baseURL: 'http://127.0.0.1:18795', headless: true, screenshot: 'only-on-failure'},
  webServer: {command: 'node tooling/serve.mjs', url: 'http://127.0.0.1:18795', reuseExistingServer: false, timeout: 20000},
});
