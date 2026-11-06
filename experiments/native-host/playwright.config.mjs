import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir: './testing',
  outputDir: './test-results/headless-artifacts',
  testMatch: '**/conformance.spec.mjs',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 20000,
  reporter: [['list'], ['json', {outputFile: 'test-results/headless-results.json'}]],
});
