import {assembleSDK} from '../../tooling/plugins.mjs';
import {test, expect} from '@playwright/test';
import {installMockNative} from './mock-native.mjs';

const sdk = await assembleSDK();

test('semantic analytics captures a draft interaction without its text or other private DOM fields', async ({page}) => {
  await installMockNative(page, {analytics: true});
  await page.goto('/compose/');
  const draft = page.getByTestId('draft');
  await expect(draft).toBeEnabled();
  await draft.click();
  await draft.pressSequentially('PRIVATE draft test@example.test');
  await page.getByRole('button', {name: /Save draft/}).click();
  await expect(page.getByTestId('action-result')).toContainText('Draft committed to native storage.');
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.observations.some(event => event.type === 'click' && event.control === 'draft.save'))).toBe(true);
  const observations = await page.evaluate(() => window.__mockNative.requests.filter(request => request.action === 'analytics.observe').map(request => request.args));
  expect(observations.filter(event => event.type === 'click' && event.control === 'draft.save')).toHaveLength(1);
  expect(observations).toContainEqual({type: 'click', kind: 'input', control: 'draft.input'});
  expect(observations).toContainEqual({type: 'change', kind: 'input', control: 'draft.input'});
  for (const observation of observations) expect(Object.keys(observation).sort()).toEqual(['control', 'kind', 'type']);
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');
  expect(JSON.stringify(observations)).not.toContain('test@example.test');
});

test('ordinary HTML semantic capture excludes sensitive/opted-out/synthetic interactions and reinjection stays single', async ({page}) => {
  await installMockNative(page, {analytics: true});
  await page.goto('/plain.html');
  await expect.poll(() => page.evaluate(() => !!window.platform && !!window.__mockNative.requests.find(request => request.action === 'hello'))).toBe(true);
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.innerHTML = '<label>Password<input type="password" data-testid="private-password" data-analytics-id="password.input" value="NEVER-RECORD"></label><div data-analytics="off"><button data-testid="private-button" data-analytics-id="private.action">Sensitive account 1234</button></div><button data-testid="semantic-button" data-analytics-id="safe.action" id="private-customer-id" name="private-customer-name">Personal label private@example.test</button>';
    document.body.append(fixture);
  });
  await page.getByTestId('private-password').click();
  await page.getByTestId('private-password').pressSequentially('SECRET');
  await page.getByTestId('private-button').click();
  await page.evaluate(() => document.querySelector('[data-testid=semantic-button]').click());
  expect(await page.evaluate(() => window.__mockNative.state.observations)).toEqual([]);
  await page.addScriptTag({content: sdk});
  await page.getByTestId('semantic-button').click();
  await expect.poll(() => page.evaluate(() => window.__mockNative.state.observations.length)).toBe(1);
  expect(await page.evaluate(() => window.__mockNative.state.observations)).toEqual([{type: 'click', kind: 'button', control: 'safe.action'}]);
  await page.evaluate(() => window.platform.dispose());
  await page.getByTestId('semantic-button').click();
  expect(await page.evaluate(() => window.__mockNative.state.observations.length)).toBe(1);
});
