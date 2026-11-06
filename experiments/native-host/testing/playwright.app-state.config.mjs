import {defineConfig} from '@playwright/test';
import path from 'node:path';
if (!process.env.NH_DRIVER_CONFIG) throw new Error('NH_DRIVER_CONFIG must name an authenticated live platform driver');
export default defineConfig({
  testDir: '.', testMatch: 'mobile-app-state.spec.mjs', workers: 1, retries: 0, timeout: 180000,
  outputDir: '../test-results/app-state-artifacts',
  reporter: [['list'], ['json', {outputFile: path.resolve(process.env.NH_MOBILE_REPORT || 'test-results/app-state-results.json')}]],
});
