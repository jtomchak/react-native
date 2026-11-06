import {test, expect} from './mobile-fixture.mjs';

test('React refs drive real native input, scrolling and WebView commands', async ({app}) => {
  const {platform} = await app.describe();
  const text = id => app.getByTestId(id).textContent();
  const tap = id => app.getByTestId(id).tap();
  await expect.poll(() => text('cmd-focus-state')).toBe('Focus: focused');
  expect(await text('cmd-input')).toBe('seed');
  await tap('cmd-blur');
  await expect.poll(() => text('cmd-focus-state')).toBe('Focus: blurred');
  await tap('cmd-clear');
  await expect.poll(() => text('cmd-input')).toBe('');
  expect(await text('cmd-change-count')).toBe('Changes: 0');
  await tap('cmd-focus');
  await expect.poll(() => text('cmd-focus-state')).toBe('Focus: focused');
  await tap('cmd-blur');

  await tap('cmd-tab-scroll');
  await tap('cmd-scroll-to');
  await expect.poll(() => text('cmd-scroll-offset')).toBe('Offset: 160');
  await tap('cmd-scroll-end');
  await expect.poll(() => text('cmd-scroll-offset')).toBe('Offset: 320');
  await tap('cmd-scroll-top');
  await expect.poll(() => text('cmd-scroll-offset')).toBe('Offset: 0');

  await tap('cmd-tab-web');
  await expect.poll(() => text('cmd-web-ready')).toBe('ready:A');
  await expect.poll(() => text('cmd-web-secondary-state')).toBe('ready:secondary');
  await tap('cmd-web-inject');
  await expect.poll(() => text('cmd-web-log')).toBe('injected');
  await tap('cmd-web-post');
  await expect.poll(() => text('cmd-web-log')).toBe('echo:quoted " 🦀');
  // WKWebView intentionally skips non-user-activated pushState entries in
  // native back/forward traversal. Create each entry with real browser input.
  const primary = await app.webView('cmd-web-primary').attach();
  await primary.tapAt({x: 80, y: 60});
  await expect.poll(() => text('cmd-web-log')).toBe('history:#one');
  await primary.tapAt({x: 80, y: 60});
  await expect.poll(() => text('cmd-web-log')).toBe('history:#two');
  await tap('cmd-web-back');
  await expect.poll(() => text('cmd-web-log')).toBe('history:#one');
  await tap('cmd-web-forward');
  await expect.poll(() => text('cmd-web-log')).toBe('history:#two');
  await tap('cmd-web-reload');
  await expect.poll(() => text('cmd-web-ready')).toBe('ready:A');
  for (const mode of ['same', 'path']) {
    await tap(`cmd-web-${mode}-history`);
    await expect.poll(() => text('cmd-web-log')).toBe(`mode:${mode}`);
    await primary.tapAt({x: 80, y: 60});
    await expect.poll(() => text('cmd-web-log')).toBe(`history:${mode}:1`);
    await primary.tapAt({x: 80, y: 60});
    await expect.poll(() => text('cmd-web-log')).toBe(`history:${mode}:2`);
    await tap('cmd-web-back');
    await expect.poll(() => text('cmd-web-log')).toBe(`history:${mode}:1`);
    await tap('cmd-web-forward');
    await expect.poll(() => text('cmd-web-log')).toBe(`history:${mode}:2`);
    await tap('cmd-web-post');
    await expect.poll(() => text('cmd-web-log')).toBe('echo:quoted " 🦀');
    if (platform === 'android') {
      // Android's inline HTML adapter must reload the actual same-document
      // URL, including query/path aliases, and establish a fresh bridge.
      await tap('cmd-web-inject');
      await expect.poll(() => text('cmd-web-log')).toBe('injected');
      await tap('cmd-web-reload');
      await expect.poll(() => text('cmd-web-ready')).toBe('ready:A');
      await tap('cmd-web-post');
      await expect.poll(() => text('cmd-web-log')).toBe('echo:quoted " 🦀');
    }
  }
  // A stop on an already loaded document verifies dispatch/health only; it
  // does not prove cancellation of an in-flight network navigation.
  await tap('cmd-web-stop');
  await tap('cmd-web-source');
  await expect.poll(() => text('cmd-web-ready')).toBe('ready:B');
  await tap('cmd-web-replace');
  await expect.poll(() => text('cmd-web-ready')).toBe('ready:B');
  await tap('cmd-web-toggle');
  await expect.poll(async () => {
    try { return (await app.driver.call('ui.find', {testID: 'cmd-web-primary'})).exists !== false; }
    catch (error) { if (/NOT_FOUND|No (native|accessible)/i.test(error.message)) return false; throw error; }
  }).toBe(false);
  await tap('cmd-web-toggle');
  await expect.poll(() => text('cmd-web-ready')).toBe('ready:B');
  expect(await text('cmd-web-secondary-state')).toBe('ready:secondary');
});
