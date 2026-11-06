import {test, expect} from './mobile-fixture.mjs';

test('real native input and embedded WebViews share one React application', async ({app}) => {
  await app.getByTestId('increment').waitFor();
  expect(await app.getByTestId('count-label').textContent()).toBe('Count: 0');
  await app.getByTestId('increment').tap();
  await expect.poll(() => app.getByTestId('count-label').textContent()).toBe('Count: 1');
  await app.getByTestId('name-input').fill('Driver');
  await app.getByTestId('echo-button').tap();
  await expect.poll(() => app.getByTestId('service-result').textContent()).toBe('Echo: Driver');
  await app.dismissKeyboard();
  const primary = await app.webView('web-primary').attach();
  const secondary = await app.webView('web-secondary').attach();
  // Coordinates are fixture-local native points, delivered through OS input.
  await primary.tapAt({x: 100, y: 80});
  await expect.poll(() => app.getByTestId('web-result').textContent()).toBe('Primary: 1');
  await app.getByTestId('toggle-overlay').tap();
  await primary.tapAt({x: 100, y: 80});
  await expect.poll(() => app.getByTestId('overlay-result').textContent()).toBe('Overlay: 1');
  expect(await app.getByTestId('web-result').textContent()).toBe('Primary: 1');
  await secondary.tapAt({x: 100, y: 80});
  await expect.poll(() => app.getByTestId('web-secondary-result').textContent()).toBe('Secondary: 1');
  expect(await app.getByTestId('web-result').textContent()).toBe('Primary: 1');
});
