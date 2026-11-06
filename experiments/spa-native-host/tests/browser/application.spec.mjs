import {test, expect} from '@playwright/test';
import {installMockNative} from './mock-native.mjs';
import {assembleSDK, loadSelectedPlugins} from '../../tooling/plugins.mjs';

test('storage removal keeps application routes usable without opening a camera or dispatching storage', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.SPA_STORAGE_REMOVED_BUILD !== '1') {
    const source = await assembleSDK({plugins: loadSelectedPlugins().filter(plugin => plugin.id !== 'storage')});
    await page.route('**/platform-sdk.js', route => route.fulfill({contentType: 'text/javascript', body: source}));
  }
  await installMockNative(page, {storage: false, auth: {}, analytics: true});
  await page.goto('/compose/');
  await expect(page.getByTestId('connection')).toHaveText('iOS host');
  await expect(page.getByText('Native storage is unavailable in this app.')).toBeVisible();
  await expect(page.getByTestId('draft')).toBeEnabled();
  await expect(page.getByRole('button', {name: /Save draft/})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Remove saved draft'})).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.toolbar?.actions.length)).toBe(0);
  expect(await page.evaluate(() => Object.hasOwn(platform, 'storage'))).toBe(false);
  expect(await page.evaluate(() => platform.auth.status().then(value => value.authenticated))).toBe(false);
  expect(await page.evaluate(() => platform.analytics.status().then(value => value.enabled))).toBe(true);
  await page.getByRole('link', {name: 'Library', exact: true}).click();
  await expect(page.getByRole('button', {name: /Take a photo/})).toBeDisabled();
  await expect(page.getByText('Native storage is unavailable in this app.')).toBeVisible();
  await page.getByRole('link', {name: 'Overview', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Take a photo', exact: true})).toBeDisabled();
  const requests = await page.evaluate(() => window.__mockNative.requests.map(request => request.action));
  expect(requests.some(action => action.startsWith('storage.') || action === 'camera.capture')).toBe(false);
  expect(errors).toEqual([]);
});

test('browser preview makes native unavailability explicit and retains useful SPA routes', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('Browser preview');
  await expect(page.getByRole('heading', {name: /Built for both worlds/})).toBeVisible();
  await page.getByRole('button', {name: 'Feel a light impact'}).click();
  await expect(page.getByTestId('action-result')).toContainText('UNAVAILABLE');
  await page.getByRole('link', {name: 'Compose', exact: true}).click();
  await expect(page).toHaveURL(/\/compose\/$/);
  await page.getByTestId('draft').fill('Browser preview does not fake a native write.');
  await page.getByRole('button', {name: /Save draft/}).click();
  await expect(page.getByTestId('action-result')).toContainText('UNAVAILABLE');
});

test('mock transport: Next links and native Back share document history and commit acknowledgments', async ({page}) => {
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));
  await installMockNative(page);
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('iOS host');
  const originalDocument = await page.evaluate(() => window.__mockNative.requests.find(request => request.action === 'hello').document);
  await page.getByRole('link', {name: 'Compose', exact: true}).click();
  await expect(page).toHaveURL(/\/compose\/$/);
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.canGoBack)).toBe(true);
  await page.getByRole('link', {name: 'Library', exact: true}).click();
  await expect(page).toHaveURL(/\/library\/$/);
  await page.evaluate(() => window.platform.navigation.back());
  await expect(page).toHaveURL(/\/compose\/$/);
  await page.evaluate(() => window.platform.navigation.back());
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.canGoBack)).toBe(false);
  const summary = await page.evaluate(() => ({hellos: window.__mockNative.requests.filter(request => request.action === 'hello').map(request => request.document), acknowledgments: window.__mockNative.requests.filter(request => request.action === 'navigation.update' && request.args.ack).length}));
  expect(summary.hellos).toEqual([originalDocument]);
  expect(summary.acknowledgments).toBe(2);
  expect(consoleErrors).toEqual([]);
});

test('mock transport: native toolbar targets only the currently mounted component', async ({page}) => {
  await installMockNative(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.toolbar?.title)).toBe('Native actions');
  await page.evaluate(() => window.__mockNative.clickToolbar('compose'));
  await expect(page).toHaveURL(/\/compose\/$/);
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.toolbar?.title)).toBe('Compose');
  await page.getByTestId('draft').fill('Saved by a native toolbar event.');
  await page.evaluate(() => window.__mockNative.clickToolbar('save'));
  await expect(page.getByTestId('action-result')).toContainText('Draft committed to native storage.');
  const registration = await page.evaluate(() => window.__mockNative.state.toolbar.registration);
  await page.getByRole('link', {name: 'Overview', exact: true}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.toolbar?.title)).toBe('Native actions');
  const count = await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'storage.set').length);
  await page.evaluate(registration => window.__mockNative.event('toolbar.action', {registration, id: 'save'}), registration);
  await expect.poll(() => page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'storage.set').length)).toBe(count);
});

test('mock transport: storage, haptic and presentation flows reflect native acknowledgments', async ({page}) => {
  await installMockNative(page);
  await page.goto('/compose/?draft=one');
  await expect(page.getByTestId('draft')).toBeEnabled();
  await page.getByTestId('draft').fill('A retained draft in the browser test double.');
  await page.getByRole('button', {name: /Save draft/}).click();
  await expect(page.getByTestId('action-result')).toContainText('Action complete');
  await page.reload();
  await expect(page.getByTestId('draft')).toHaveValue('A retained draft in the browser test double.');
  await page.getByRole('button', {name: 'Remove saved draft'}).click();
  await expect(page.getByTestId('draft')).toHaveValue('');
  await page.getByRole('link', {name: 'Overview', exact: true}).click();
  await page.getByRole('button', {name: 'Feel a light impact'}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.haptics)).toBe(1);
  await page.getByRole('button', {name: /Open native sheet/}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.modal)).toBe(true);
  await page.evaluate(() => window.platform.navigation.back());
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.modal)).toBe(false);
  await expect(page).toHaveURL(/:\d+\/$/);
});

test('plain HTML fixture uses the same SDK without React or Next application code', async ({page}) => {
  await installMockNative(page);
  await page.goto('/plain.html');
  await expect(page.locator('#connection')).toHaveText('Connected to ios');
  await page.getByRole('textbox', {name: 'A plain HTML draft'}).fill('No framework required.');
  await page.getByRole('button', {name: 'Save draft', exact: true}).click();
  await expect(page.locator('#result')).toContainText('"ok": true');
  await page.getByRole('textbox', {name: 'A plain HTML draft'}).fill('');
  await page.getByRole('button', {name: 'Read draft', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'A plain HTML draft'})).toHaveValue('No framework required.');
  await page.getByRole('button', {name: 'Light impact'}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.haptics)).toBe(1);
  expect(await page.locator('script[src*="_next"]').count()).toBe(0);
});

test('mobile layout fits the viewport and controls remain reachable', async ({page}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('Browser preview');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', {name: 'Take a photo'})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('mobile-overview.png'), fullPage: true});
});

test('wide headings preserve word spacing when responsive line breaks collapse', async ({page}) => {
  await page.setViewportSize({width: 1024, height: 768});
  for (const [route, title] of [
    ['/', 'Built for both worlds.'],
    ['/compose/', 'A thought worth keeping.'],
    ['/library/', 'A moment, made yours.'],
  ]) {
    await page.goto(route);
    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    expect(await heading.evaluate(element => element.innerText.replace(/\s+/g, ' ').trim())).toBe(title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
