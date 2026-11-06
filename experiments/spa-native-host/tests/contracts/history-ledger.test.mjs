import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryLedger, subscribeHistoryUpdates} from '../../packages/platform-react/history-ledger.mjs';

function browser() {
  const events = new Map();
  const entries = [{state: {__NA: true, next: 'retained'}, url: '/'}];
  let current = 0;
  const window = {location: {href: '/'}, addEventListener(name, listener) {events.set(name, listener);}, removeEventListener(name, listener) {if (events.get(name) === listener) events.delete(name);}};
  const history = {
    get state() {return entries[current].state;},
    pushState(state, unused, url) {entries.splice(++current); entries[current] = {state, url}; window.location.href = url;},
    replaceState(state, unused, url) {entries[current] = {state, url}; window.location.href = url;},
    go(delta) {current += delta; window.location.href = entries[current].url; events.get('popstate')?.({state: entries[current].state});},
  };
  window.history = history;
  return {window, history, events};
}

test('document history starts at root without inventing a predecessor and retains Next metadata', () => {
  const {window, history} = browser();
  const ledger = createHistoryLedger(window);
  assert.equal(ledger.index, 0);
  assert.equal(history.state.__NA, true);
  assert.equal(history.state.next, 'retained');
  ledger.dispose();
});

test('push, replace, back and forward track browser entries, including identical URLs', () => {
  const {window, history} = browser();
  const ledger = createHistoryLedger(window);
  history.pushState({__NA: true}, '', '/compose/');
  history.replaceState({__NA: true}, '', '/compose/?draft=one');
  assert.equal(ledger.index, 1);
  history.pushState({__NA: true}, '', '/compose/?draft=one');
  assert.equal(ledger.index, 2);
  history.go(-1);
  assert.equal(ledger.index, 1);
  history.go(-1);
  assert.equal(ledger.index, 0);
  history.go(1);
  assert.equal(ledger.index, 1);
  ledger.dispose();
});

test('Strict Mode setup/cleanup restores original methods and preserves entry identity', () => {
  const {window, history, events} = browser();
  const push = history.pushState;
  const ledger = createHistoryLedger(window);
  history.pushState({}, '', '/library/');
  const metadata = history.state.__spaHostHistoryV1;
  ledger.dispose();
  assert.equal(history.pushState, push);
  assert.equal(events.size, 0);
  const again = createHistoryLedger(window);
  assert.equal(again.index, 1);
  assert.deepEqual(history.state.__spaHostHistoryV1, metadata);
  again.dispose();
});

test('cleanup does not overwrite a later history wrapper installed by another owner', () => {
  const {window, history} = browser();
  const ledger = createHistoryLedger(window);
  const other = () => {};
  history.pushState = other;
  ledger.dispose();
  assert.equal(history.pushState, other);
});

test('metadata-only replacements do not notify React, but route and history entry changes do', () => {
  const {window, history} = browser();
  const ledger = createHistoryLedger(window);
  let notifications = 0;
  ledger.subscribe(() => notifications++);
  history.replaceState({__NA: true, next: 'new metadata'}, '', '/');
  history.replaceState({__NA: true, next: 'another update'}, '', '/');
  assert.equal(notifications, 0);
  assert.equal(history.state.next, 'another update');
  history.pushState({__NA: true}, '', '/');
  assert.equal(notifications, 1, 'same URL with a new back entry still changes navigation state');
  history.replaceState({__NA: true}, '', '/compose/');
  assert.equal(notifications, 2);
  history.go(-1);
  assert.equal(notifications, 3);
  ledger.dispose();
});

test('React subscription defers insertion-phase history writes and coalesces the commit', async () => {
  const {window, history} = browser();
  const ledger = createHistoryLedger(window);
  const observed = [];
  const unsubscribe = subscribeHistoryUpdates(ledger, () => observed.push(ledger.index));
  history.pushState({__NA: true}, '', '/compose/');
  history.replaceState({__NA: true}, '', '/compose/?draft=one');
  history.pushState({__NA: true}, '', '/library/');
  assert.equal(ledger.index, 2, 'native bookkeeping remains synchronous');
  assert.deepEqual(observed, [], 'React receives no callback during insertion-phase history writes');
  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(observed, [2], 'one notification observes the final committed history state');
  history.go(-1);
  unsubscribe();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(observed, [2], 'Strict Mode/unmount cleanup invalidates already queued callbacks');
  ledger.dispose();
});
