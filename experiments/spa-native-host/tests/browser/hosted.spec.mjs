import {test, expect} from '@playwright/test';

test.describe('actual production Next hosted server', () => {
  test.skip(!process.env.SPA_HOSTED_TEST_URL, 'Run hosted.playwright.mjs against an owned production server.');
  test('request-time rendering changes its nonce while sharing the client application routes', async ({page}) => {
    await page.goto(`${process.env.SPA_HOSTED_TEST_URL}/hosted/`);
    const first = await page.getByTestId('server-nonce').textContent();
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    await page.reload();
    await expect(page.getByTestId('server-nonce')).not.toHaveText(first);
    await page.getByRole('link', {name: 'Visit Compose natively'}).click();
    await expect(page.getByTestId('draft')).toBeVisible();
    await expect(page.getByTestId('connection')).toContainText('Browser preview');
  });

  test('server action commits an HttpOnly cookie and server rendering reads it after reload', async ({page, context}) => {
    await page.goto(`${process.env.SPA_HOSTED_TEST_URL}/hosted/`);
    await expect(page.getByTestId('server-preference')).toHaveText('none');
    await page.getByRole('button', {name: 'Save forest on server'}).click();
    await expect(page.getByTestId('server-preference')).toHaveText('forest');
    await page.reload();
    await expect(page.getByTestId('server-preference')).toHaveText('forest');
    const cookie = (await context.cookies()).find(value => value.name === 'spa-demo-preference');
    expect(cookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie.includes('spa-demo-preference'))).toBe(false);
  });

  test('hosted health is dynamic server data and the independent injection fixture remains available', async ({request, page}) => {
    const response = await request.get(`${process.env.SPA_HOSTED_TEST_URL}/api/health/`);
    expect(response.status()).toBe(200);
    expect((await response.json()).mode).toBe('hosted');
    await page.goto(`${process.env.SPA_HOSTED_TEST_URL}/injected.html`);
    expect(await page.evaluate(() => window.__sdkInjectedBeforePage)).toBe(false);
    await expect(page.locator('#status')).toContainText('normal browser');
  });

  test('dynamic server item routes accept identifiers that were never packaged', async ({page}) => {
    await page.goto(`${process.env.SPA_HOSTED_TEST_URL}/hosted/`);
    await page.getByRole('link', {name: 'Visit server item 42 →'}).click();
    await expect(page.getByTestId('server-item-id')).toHaveText('42');
    const first = await page.getByTestId('server-nonce').textContent();
    await page.goto(`${process.env.SPA_HOSTED_TEST_URL}/hosted/item/fresh_73/`);
    await expect(page.getByTestId('server-item-id')).toHaveText('fresh_73');
    await expect(page.getByTestId('server-nonce')).not.toHaveText(first);
    await page.reload();
    await expect(page.getByTestId('server-item-id')).toHaveText('fresh_73');
  });
});
