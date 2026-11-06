import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
export default defineConfig({testDir: '.', testMatch: 'auth-server.spec.mjs', timeout: 45000, workers: 1, use: {headless: true, baseURL: 'http://localhost:18801'}, reporter: [['list'], ['json', {outputFile: fileURLToPath(new URL('../../evidence/auth-server-browser-results.json', import.meta.url))}]]});
