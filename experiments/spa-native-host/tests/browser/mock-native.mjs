// Browser-only test double. Its results do not establish any device behavior.
export async function installMockNative(page, options = {}) {
  await page.addInitScript(options => {
    const requests = [];
    let identity = null;
    let currentSession = null;
    let pendingBack = null;
    const state = {path: '/', title: '', canGoBack: false, toolbar: null, modal: false, haptics: 0, visits: [], subscriptions: {}, observations: [], customEvents: [], auth: options.auth?.status || {authenticated: false, configured: false, providers: [], passkeys: false}, pendingAuthStatus: [], pendingAuthActions: []};
    const capabilities = ['navigation.update', 'navigation.back', 'navigation.present', 'navigation.dismiss', 'toolbar.set', 'toolbar.clear', 'haptics.impact', 'storage.get', 'storage.set', 'storage.remove', 'camera.capture', 'files.previewURL', 'files.remove'].filter(action => options.storage !== false || !action.startsWith('storage.'));
    const host = options.native ? {apiVersion: 2, contentMode: options.contentMode || 'packaged', navigationMode: 'native', chromeMode: options.chromeMode || 'tabs', surfaceId: 'mock-surface', activeTab: 'overview'} : null;
    if (host) capabilities.push('navigation.visit', 'events.subscribe', 'events.unsubscribe', 'chrome.state', 'chrome.selectTab');
    if (options.auth) capabilities.push('auth.status', 'auth.signIn', 'auth.registerPasskey', 'auth.signOut', 'auth.syncWebSession');
    if (options.analytics) capabilities.push('analytics.observe', 'analytics.track', 'analytics.status', 'analytics.flush');
    const send = message => queueMicrotask(() => window.__spaReceive(message));
    const response = (request, result) => send({v: 1, id: request.id, document: request.document, session: currentSession, ok: true, result});
    const event = (event, data) => {
      const envelope = {v: 1, document: identity, session: currentSession, event, data};
      if (event === 'toolbar.action' || event === 'navigation.back') send(envelope);
      else for (const [subscription, name] of Object.entries(state.subscriptions)) if (name === event) send({...envelope, subscription});
    };
    window.__mockNative = {requests, state, event, finishAuthStatus(index, summary) { const request = state.pendingAuthStatus[index]; if (request) { state.pendingAuthStatus[index] = null; response(request, summary); } }, rejectAuthStatus(index, code, message) { const request = state.pendingAuthStatus[index]; if (request) { state.pendingAuthStatus[index] = null; send({v: 1, id: request.id, document: request.document, session: currentSession, ok: false, error: {code, message}}); } }, finishAuthAction(index, result) { const request = state.pendingAuthActions[index]; if (request) { state.pendingAuthActions[index] = null; response(request, result); } }, rejectAuthAction(index, code, message) { const request = state.pendingAuthActions[index]; if (request) { state.pendingAuthActions[index] = null; send({v: 1, id: request.id, document: request.document, session: currentSession, ok: false, error: {code, message}}); } }, clickToolbar(id) {if (state.toolbar) event('toolbar.action', {registration: state.toolbar.registration, id});}};
    Object.defineProperty(window, '__SPA_TRANSPORT__', {value: Object.freeze({postMessage(json) {
      const request = JSON.parse(json);
      requests.push(request);
      const {action, args} = request;
      if (action === 'hello') {
        identity = request.document;
        currentSession = `mock-${identity}`;
        response(request, {platform: 'ios', capabilities, ...(host ? {host} : {})});
      } else if (action.startsWith('storage.') && options.storage === false) send({v: 1, id: request.id, document: request.document, session: currentSession, ok: false, error: {code: 'UNSUPPORTED', message: 'Storage is not installed.'}});
      else if (action === 'storage.get') response(request, localStorage.getItem(`mock-native:${args.key}`));
      else if (action === 'storage.set') {localStorage.setItem(`mock-native:${args.key}`, args.value); response(request, null);}
      else if (action === 'storage.remove') {localStorage.removeItem(`mock-native:${args.key}`); response(request, null);}
      else if (action === 'navigation.update') {
        Object.assign(state, args);
        response(request, null);
        if (pendingBack && args.ack === pendingBack.token) {const previous = pendingBack; pendingBack = null; response(previous.request, null);}
      } else if (action === 'navigation.back') {
        if (state.modal) {state.modal = false; response(request, null);}
        else if (!state.canGoBack) response(request, null);
        else {pendingBack = {request, token: `back-${request.id}`}; event('navigation.back', {token: pendingBack.token});}
      } else if (action === 'navigation.present') {state.modal = true; response(request, null);}
      else if (action === 'navigation.dismiss') {state.modal = false; response(request, null);}
      else if (action === 'toolbar.set') {state.toolbar = args; response(request, null);}
      else if (action === 'toolbar.clear') {if (state.toolbar?.registration === args.registration) state.toolbar = null; response(request, null);}
      else if (action === 'haptics.impact') {state.haptics++; response(request, null);}
      else if (action === 'navigation.visit') {state.visits.push(args); response(request, {surfaceId: 'mock-visit', path: args.path});}
      else if (action === 'events.subscribe') {state.subscriptions[args.subscription] = args.event; response(request, null);}
      else if (action === 'events.unsubscribe') {delete state.subscriptions[args.subscription]; response(request, null);}
      else if (action === 'chrome.state') response(request, {...host, depth: 1});
      else if (action === 'auth.status') {if (options.auth?.deferStatus) state.pendingAuthStatus.push(request); else response(request, state.auth);}
      else if (action.startsWith('auth.') && options.auth?.deferActions?.includes(action)) state.pendingAuthActions.push(request);
      else if (action.startsWith('auth.')) send({v: 1, id: request.id, document: request.document, session: currentSession, ok: false, error: {code: 'UNAVAILABLE', message: 'Browser test double has no native authentication provider.'}});
      else if (action === 'analytics.observe') {state.observations.push(args); response(request, {accepted: true});}
      else if (action === 'analytics.track') {state.customEvents.push(args); response(request, {accepted: true});}
      else if (action === 'analytics.status') response(request, {enabled: true, configured: false, count: state.observations.length + state.customEvents.length});
      else if (action === 'analytics.flush') response(request, {configured: false, accepted: 0});
      else if (action === 'camera.capture') response(request, {file: 'test-photo-opaque', mimeType: 'image/jpeg'});
      else if (action === 'files.previewURL') response(request, 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23235a46"/%3E%3C/svg%3E');
      else response(request, null);
    }}), configurable: false});
  }, options);
}
