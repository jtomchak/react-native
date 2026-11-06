import {readFile} from 'node:fs/promises';
import {test as base, expect} from '@playwright/test';
import {NativeApp, NativeDriver} from './native-driver.mjs';

export {expect};
export const test = base.extend({
  app: async ({}, use, testInfo) => {
    const config = JSON.parse(await readFile(process.env.NH_DRIVER_CONFIG, 'utf8'));
    const driver = await NativeDriver.connect(config);
    const app = new NativeApp(driver);
    try {
      const identity = await app.describe();
      await testInfo.attach('native-driver-identity', {body: JSON.stringify(identity, null, 2), contentType: 'application/json'});
      await app.health();
      await use(app);
    } finally {
      try { await testInfo.attach('final-native-snapshot', {body: JSON.stringify(await app.snapshot(), null, 2), contentType: 'application/json'}); } catch {}
      try { await app.health(); } finally {
        try { await driver.close(); } finally {
          await testInfo.attach('native-driver-trace', {body: JSON.stringify(driver.trace, null, 2), contentType: 'application/json'});
        }
      }
    }
  },
});
