import {test, expect} from '@playwright/test';
import {installMockNative} from './mock-native.mjs';

test('legacy web mode NativeLink remains a Next transition without native visit dispatch', async ({page}) => {
  await installMockNative(page);
  await page.goto('/');
  await expect(page.getByTestId('connection')).toContainText('iOS host');
  await page.evaluate(() => { window.__visitNonce = 'kept'; });
  await page.getByRole('link', {name: 'Push Compose →'}).click();
  await expect(page.getByTestId('draft')).toBeVisible();
  expect(await page.evaluate(() => window.__visitNonce)).toBe('kept');
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'navigation.visit').length)).toBe(0);
});

test('native mode intercepts NativeLink once and native chrome removes duplicate web tabs', async ({page}) => {
  await installMockNative(page, {native: true, chromeMode: 'tabs'});
  await page.goto('/');
  await expect(page.getByTestId('connection')).toContainText('iOS host');
  await expect(page.getByRole('navigation', {name: 'Application'})).toHaveCount(0);
  await page.getByRole('link', {name: 'Push Compose →'}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.visits.length)).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => window.__mockNative.state.visits[0])).toEqual({path: '/compose/', presentation: 'push'});
});

test('foreground activation refreshes toolbar without creating a route synchronization loop', async ({page}) => {
  await installMockNative(page, {native: true});
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.toolbar?.title)).toBe('Native actions');
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('navigation.changed'))).toBe(true);
  const before = await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'toolbar.set').length);
  await page.evaluate(() => window.__mockNative.event('navigation.changed', {reason: 'activated', host: {apiVersion: 2, contentMode: 'packaged', navigationMode: 'native', chromeMode: 'tabs', surfaceId: 'mock-surface', activeTab: 'overview'}}));
  await expect.poll(() => page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'toolbar.set').length)).toBe(before + 1);
  const commits = await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'navigation.update').length);
  await page.evaluate(() => window.__mockNative.event('navigation.changed', {reason: 'route'}));
  // A route receipt is not a foreground activation and must not echo commits.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'navigation.update').length)).toBe(commits);
});
