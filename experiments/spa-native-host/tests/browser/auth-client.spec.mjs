import {test, expect} from '@playwright/test';
import {installMockNative} from './mock-native.mjs';

// These exercise client coordination using an explicit browser-only native
// double. Real OAuth, credential prompts, and cookie installation have separate
// server/native verification. Deferred acknowledgments below exercise document
// cache invalidation, not actual credential or cookie installation.
test('older host keeps authentication unavailable and never starts a native prompt', async ({page}) => {
  await installMockNative(page, {native: true});
  await page.goto('/');
  await expect(page.getByTestId('auth-status')).toHaveText('Open a compatible native host to authenticate.');
  await expect(page.getByRole('button', {name: 'Sign in with a passkey'})).toBeDisabled();
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action.startsWith('auth.')).length)).toBe(0);
});

test('unconfigured native auth displays explicit state without invoking sign-in', async ({page}) => {
  await installMockNative(page, {native: true, auth: {}});
  await page.goto('/');
  await expect(page.getByTestId('auth-status')).toContainText('Authentication is not configured.');
  await expect(page.getByRole('button', {name: 'Sign in with a passkey'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Add a passkey'})).toBeDisabled();
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'auth.signIn').length)).toBe(0);
});

test('new native auth event wins over an older outstanding status response', async ({page}) => {
  await installMockNative(page, {native: true, auth: {deferStatus: true}});
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('auth.changed'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthStatus.length)).toBeGreaterThan(0);
  await page.evaluate(() => window.__mockNative.event('auth.changed', {authenticated: true, user: {id: 'account-event', name: 'Event account'}, expiresAt: 1900000000000, accessToken: 'must-not-render'}));
  await expect(page.getByRole('heading', {name: 'Signed in as Event account'})).toBeVisible();
  await page.evaluate(() => window.__mockNative.finishAuthStatus(0, {authenticated: false, configured: true, providers: ['test'], passkeys: true}));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('heading', {name: 'Signed in as Event account'})).toBeVisible();
  await expect(page.locator('body')).not.toContainText('must-not-render');
  await page.evaluate(() => window.__mockNative.event('auth.changed', {authenticated: false}));
  await expect(page.getByRole('heading', {name: 'OAuth and passkeys, presented natively.'})).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Event account');
});

test('configured provider failure remains a typed failure rather than a signed-in UI', async ({page}) => {
  await installMockNative(page, {native: true, auth: {status: {authenticated: false, configured: true, providers: ['test'], passkeys: true}}});
  await page.goto('/');
  await page.getByRole('button', {name: 'Sign in with test'}).click();
  await expect(page.getByRole('region', {name: 'Native authentication'}).getByRole('alert')).toContainText('UNAVAILABLE: Browser test double has no native authentication provider.');
  await expect(page.getByTestId('auth-status')).toHaveText('No native session is active.');
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'auth.signIn').length)).toBe(1);
});

const authenticatedStatus = {authenticated: true, user: {id: 'account-a', name: 'Account A'}, expiresAt: 1900000000000, configured: true, providers: ['test'], passkeys: true};

for (const action of ['syncWebSession', 'signOut']) {
  test(`hosted ${action} replaces the document only after native acknowledgement`, async ({page}) => {
    await installMockNative(page, {native: true, contentMode: 'hosted', auth: {status: authenticatedStatus, deferActions: [`auth.${action}`]}});
    await page.goto('/');
    await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toBeVisible();
    await page.evaluate(() => { window.__authDocumentMarker = 'original'; });
    let documents = 0;
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
    await page.getByRole('button', {name: action === 'signOut' ? 'Sign out' : 'Sync web session', exact: true}).click();
    await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(1);
    if (action === 'signOut') {
      // Native can publish the new summary before acknowledging the bridge call.
      // Reloading here would strand that operation before cookie clearing ends.
      await page.evaluate(() => window.__mockNative.event('auth.changed', {authenticated: false}));
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(documents).toBe(0);
    expect(await page.evaluate(() => window.__authDocumentMarker)).toBe('original');
    await page.evaluate(action => window.__mockNative.finishAuthAction(0, action === 'signOut' ? {authenticated: false, revoked: true} : {synchronized: true}), action);
    await expect.poll(() => documents).toBe(1);
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => window.__authDocumentMarker)).toBeUndefined();
    // Initial status on the replacement document is a baseline, rather than
    // another change requiring an endless reload. The fixture resets its state.
    await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(documents).toBe(1);
  });
}

test('hosted external identity summaries update React without navigating before the native host commits', async ({page}) => {
  await installMockNative(page, {native: true, contentMode: 'hosted', auth: {status: authenticatedStatus}});
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('auth.changed'))).toBe(true);
  await page.evaluate(() => { window.__authDocumentMarker = 'original'; });
  let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.evaluate(status => window.__mockNative.event('auth.changed', {...status, user: {...status.user, name: 'Updated account name'}, expiresAt: status.expiresAt + 1000}), authenticatedStatus);
  await expect(page.getByRole('heading', {name: 'Signed in as Updated account name'})).toBeVisible();
  await page.evaluate(status => window.__mockNative.event('auth.changed', {...status, user: {id: 'account-b', name: 'Account B'}}), authenticatedStatus);
  await expect(page.getByRole('heading', {name: 'Signed in as Account B'})).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(documents).toBe(0);
  expect(await page.evaluate(() => window.__authDocumentMarker)).toBe('original');
});

test('hosted first auth event updates state without requesting React navigation', async ({page}) => {
  await installMockNative(page, {native: true, contentMode: 'hosted', auth: {deferStatus: true}});
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('auth.changed'))).toBe(true);
  let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.evaluate(status => window.__mockNative.event('auth.changed', status), authenticatedStatus);
  await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(documents).toBe(0);
});

const anonymousConfigured = {authenticated: false, configured: true, providers: ['test'], passkeys: true};

test('hosted sign-in stays busy until native login and automatic web-session sync both acknowledge', async ({page}) => {
  await installMockNative(page, {native: true, contentMode: 'hosted', auth: {status: anonymousConfigured, deferActions: ['auth.signIn', 'auth.syncWebSession']}});
  await page.goto('/');
  await page.getByRole('button', {name: 'Sign in with test'}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(1);
  let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.evaluate(status => {
    window.__mockNative.event('auth.changed', status);
    window.__mockNative.finishAuthAction(0, status);
  }, authenticatedStatus);
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(2);
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action.startsWith('auth.')).map(request => request.action))).toEqual(['auth.status', 'auth.signIn', 'auth.syncWebSession']);
  await expect(page.getByRole('button', {name: 'Refresh session status'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeDisabled();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(documents).toBe(0);
  await page.evaluate(() => window.__mockNative.finishAuthAction(1, {synchronized: true}));
  await expect.poll(() => documents).toBe(1);
  await page.waitForLoadState('load');
});

test('hosted failed automatic sync rolls back native sign-in before reloading', async ({page}) => {
  await installMockNative(page, {native: true, contentMode: 'hosted', auth: {status: anonymousConfigured, deferActions: ['auth.signIn', 'auth.syncWebSession', 'auth.signOut']}});
  await page.goto('/');
  await page.getByRole('button', {name: 'Sign in with test'}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(1);
  let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.evaluate(status => {
    window.__mockNative.event('auth.changed', status);
    window.__mockNative.finishAuthAction(0, status);
  }, authenticatedStatus);
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(2);
  await page.evaluate(() => window.__mockNative.rejectAuthAction(1, 'IO_ERROR', 'Cookie installation failed.'));
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(3);
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action.startsWith('auth.')).map(request => request.action))).toEqual(['auth.status', 'auth.signIn', 'auth.syncWebSession', 'auth.signOut']);
  await expect(page.getByRole('button', {name: 'Refresh session status'})).toBeDisabled();
  await expect(page.getByTestId('auth-notice')).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(documents).toBe(0);
  await page.evaluate(() => {
    window.__mockNative.event('auth.changed', {authenticated: false});
    window.__mockNative.finishAuthAction(2, {authenticated: false, revoked: true});
  });
  await expect.poll(() => documents).toBe(1);
  await page.waitForLoadState('load');
});

test('raw hosted sign-in primitive survives auth.changed before its acknowledgement and subsequent cookie sync', async ({page}) => {
  await installMockNative(page, {native: true, contentMode: 'hosted', auth: {status: anonymousConfigured, deferActions: ['auth.signIn', 'auth.syncWebSession']}});
  await page.goto('/');
  await expect(page.getByTestId('auth-status')).toContainText('No native session is active.');
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('auth.changed'))).toBe(true);
  let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.evaluate(() => {
    window.__rawAuthState = 'pending';
    window.platform.call('auth.signIn', {method: 'oauth', provider: 'test'})
      .then(() => { window.__rawAuthState = 'acknowledged'; }, () => { window.__rawAuthState = 'failed'; });
  });
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(1);
  await page.evaluate(status => window.__mockNative.event('auth.changed', status), authenticatedStatus);
  await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(documents).toBe(0);
  expect(await page.evaluate(() => window.__rawAuthState)).toBe('pending');
  await page.evaluate(status => window.__mockNative.finishAuthAction(0, status), authenticatedStatus);
  await expect.poll(() => page.evaluate(() => window.__rawAuthState)).toBe('acknowledged');
  await page.evaluate(() => {
    window.platform.call('auth.syncWebSession', {})
      .then(() => { window.__rawAuthState = 'synchronized'; }, () => { window.__rawAuthState = 'failed'; });
  });
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(2);
  await page.evaluate(() => window.__mockNative.finishAuthAction(1, {synchronized: true}));
  await expect.poll(() => page.evaluate(() => window.__rawAuthState)).toBe('synchronized');
  expect(documents).toBe(0);
});

test('foreground activation joins a pending status read and its first valid result enables sign-out', async ({page}) => {
  await installMockNative(page, {native: true, contentMode: 'hosted', auth: {deferStatus: true}});
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthStatus.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('navigation.changed'))).toBe(true);
  await page.evaluate(() => window.__mockNative.event('navigation.changed', {reason: 'activated', host: {apiVersion: 2, contentMode: 'hosted', navigationMode: 'native', chromeMode: 'tabs', surfaceId: 'mock-surface', activeTab: 'overview'}}));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // A second native read would be rejected BUSY while the first owns native
  // auth. Joining preserves the first response's generation instead.
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'auth.status').length)).toBe(1);
  await page.evaluate(status => window.__mockNative.finishAuthStatus(0, status), authenticatedStatus);
  await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeEnabled();
  await expect(page.getByRole('region', {name: 'Native authentication'}).getByRole('alert')).toHaveCount(0);
});

test('native BUSY status retries briefly without requiring a manual refresh', async ({page}) => {
  await installMockNative(page, {native: true, auth: {deferStatus: true}});
  await page.goto('/');
  for (let index = 0; index < 3; index++) {
    await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthStatus.length)).toBe(index + 1);
    await page.evaluate(index => window.__mockNative.rejectAuthStatus(index, 'BUSY', 'Native auth operation is busy.'), index);
  }
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthStatus.length)).toBe(4);
  await page.evaluate(status => window.__mockNative.finishAuthStatus(3, status), authenticatedStatus);
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeEnabled();
  await expect(page.getByRole('region', {name: 'Native authentication'}).getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'auth.status').length)).toBe(4);
});

test('interactive auth cancels a pending status read and a late read cannot restore the previous account', async ({page}) => {
  await installMockNative(page, {native: true, auth: {deferStatus: true, deferActions: ['auth.signOut']}});
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthStatus.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => Object.values(window.__mockNative.state.subscriptions).includes('auth.changed'))).toBe(true);
  await page.evaluate(status => window.__mockNative.event('auth.changed', status), authenticatedStatus);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.pendingAuthActions.length)).toBe(1);
  const sequence = await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'cancel' || request.action.startsWith('auth.')).map(request => ({action: request.action, id: request.id, args: request.args})));
  expect(sequence.map(request => request.action)).toEqual(['auth.status', 'cancel', 'auth.signOut']);
  expect(sequence[1].args.requestId).toBe(sequence[0].id);
  await page.evaluate(() => window.__mockNative.finishAuthAction(0, {authenticated: false, revoked: true}));
  await expect(page.getByRole('heading', {name: 'OAuth and passkeys, presented natively.'})).toBeVisible();
  await page.evaluate(status => window.__mockNative.finishAuthStatus(0, status), authenticatedStatus);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('heading', {name: 'Signed in as Account A'})).toHaveCount(0);
});
