const key = '__spaHostHistoryV1';

// Next writes browser history from useInsertionEffect. Ledger bookkeeping must
// remain synchronous, but React subscribers must run after that commit phase.
export function subscribeHistoryUpdates(ledger, callback, enqueue = queueMicrotask) {
  let active = true;
  let queued = false;
  const unsubscribe = ledger.subscribe(() => {
    if (!active || queued) return;
    queued = true;
    enqueue(() => {
      queued = false;
      if (active) callback();
    });
  });
  return () => { active = false; unsubscribe(); };
}

// Metadata belongs to browser history entries. Next remains the route owner;
// this only gives the native toolbar a reliable document-local back capability.
export function createHistoryLedger(window) {
  const {history} = window;
  const initial = history.state?.[key];
  const owner = typeof initial?.owner === 'string' ? initial.owner : Math.random().toString(36).slice(2);
  let index = initial?.owner === owner && Number.isInteger(initial.index) ? initial.index : 0;
  const listeners = new Set();
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  const stateWithIndex = (state, next) => ({...(state && typeof state === 'object' ? state : {}), [key]: {owner, index: next}});
  originalReplace.call(history, stateWithIndex(history.state, index), '', window.location.href);
  let lastIndex = index;
  let lastURL = window.location.href;

  function notify() {
    // Next can replace its internal history metadata without navigating. Do not
    // turn those writes into React state updates and another synchronization.
    if (index === lastIndex && window.location.href === lastURL) return;
    lastIndex = index;
    lastURL = window.location.href;
    for (const listener of [...listeners]) listener();
  }
  function push(state, unused, url) {
    const next = index + 1;
    originalPush.call(history, stateWithIndex(state, next), unused, url);
    index = next;
    notify();
  }
  function replace(state, unused, url) {
    originalReplace.call(history, stateWithIndex(state, index), unused, url);
    notify();
  }
  function pop(event) {
    const metadata = event.state?.[key];
    index = metadata?.owner === owner && Number.isInteger(metadata.index) ? metadata.index : 0;
    notify();
  }
  history.pushState = push;
  history.replaceState = replace;
  window.addEventListener('popstate', pop);
  return {
    get index() { return index; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() {
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
      window.removeEventListener('popstate', pop);
      listeners.clear();
    },
  };
}
