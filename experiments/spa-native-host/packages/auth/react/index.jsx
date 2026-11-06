'use client';

import {useCallback, useEffect, useRef, useState} from 'react';

// Session summaries are the only authentication data exposed to React. Native
// owns credentials, refresh, presentation, and the WebView's HttpOnly cookie.
export function useAuth({platform, capabilities, connection, foregroundEpoch}) {
  const available = connection === 'connected' && !!platform?.auth && capabilities?.capabilities.includes('auth.status');
  const hosted = capabilities?.host?.contentMode === 'hosted';
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const controllers = useRef(new Set());
  const operation = useRef(null);
  const statusFlight = useRef(null);
  const reloadRequested = useRef(false);
  const reloadHosted = useCallback(() => {
    if (!hosted || !alive.current || reloadRequested.current) return;
    // A native cookie write does not invalidate Next's prefetched RSC/router
    // cache. A new document discards that cache before showing another identity.
    reloadRequested.current = true;
    window.location.reload();
  }, [hosted]);
  const mergeSession = useCallback(summary => setSession(previous => ({
    ...(previous?.configured !== undefined ? {configured: previous.configured} : {}),
    ...(previous?.providers ? {providers: previous.providers} : {}),
    ...(previous?.passkeys !== undefined ? {passkeys: previous.passkeys} : {}),
    ...summary,
  })), []);

  const adoptSession = useCallback(summary => {
    // Native owns authentication epochs and hosted-page retirement. An external
    // auth.changed may precede a raw bridge signIn acknowledgment or cookie sync;
    // React must not retire that document or orphan the primitive's promise.
    mergeSession(summary);
  }, [mergeSession]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; generation.current++;
      operation.current = null;
      statusFlight.current = null;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!available || operation.current) return null;
    // Activation can update both host metadata and foregroundEpoch while a
    // network-backed status call is pending. Joining must not invalidate the
    // only successful response by advancing its generation.
    if (statusFlight.current) return statusFlight.current.promise;
    const version = ++generation.current;
    const controller = new AbortController(); controllers.current.add(controller);
    const flight = {controller, promise: null}; statusFlight.current = flight;
    if (alive.current) { setLoading(true); setError(null); }
    const pause = milliseconds => new Promise((resolve, reject) => {
      const cancelled = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancelled);
        reject(Object.assign(new Error('Session refresh was cancelled.'), {code: 'CANCELLED'}));
      };
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', cancelled); resolve(); }, milliseconds);
      controller.signal.addEventListener('abort', cancelled, {once: true});
      if (controller.signal.aborted) cancelled();
    });
    flight.promise = (async () => {
      try {
        const retryDelays = [100, 250, 500];
        for (let attempt = 0; ; attempt++) {
          try {
            const summary = await platform.auth.status({}, {signal: controller.signal});
            if (alive.current && version === generation.current) adoptSession(summary);
            return summary;
          } catch (failure) {
            if (failure.code !== 'BUSY' || attempt >= retryDelays.length || controller.signal.aborted || !alive.current || version !== generation.current || operation.current) throw failure;
            await pause(retryDelays[attempt]);
            if (controller.signal.aborted || !alive.current || version !== generation.current || operation.current) return null;
          }
        }
      } catch (failure) {
        if (alive.current && version === generation.current) setError(failure);
        return null;
      } finally {
        controllers.current.delete(controller);
        if (statusFlight.current === flight) statusFlight.current = null;
        if (alive.current && version === generation.current) setLoading(false);
      }
    })();
    return flight.promise;
  }, [available, platform, adoptSession]);

  useEffect(() => {
    if (!available) { generation.current++; setSession(null); setLoading(false); return; }
    refresh();
    if (!capabilities.capabilities.includes('events.subscribe')) return;
    return platform.on('auth.changed', summary => {
      generation.current++;
      if (alive.current) { adoptSession(summary); setLoading(false); setError(null); }
    });
  }, [available, platform, capabilities, foregroundEpoch, refresh, adoptSession]);

  const execute = useCallback(async (method, args = {}) => {
    if (!available) throw Object.assign(new Error('Native authentication is not available in this host.'), {code: 'UNAVAILABLE'});
    if (operation.current) throw Object.assign(new Error('An authentication operation is already running.'), {code: 'BUSY'});
    const controller = new AbortController();
    const token = {controller}; operation.current = token;
    const version = ++generation.current;
    controllers.current.add(controller);
    if (alive.current) { setBusy(true); setLoading(false); setError(null); }
    try {
      // Native has one auth coordinator. Retire a pending read before admitting
      // an interactive operation, including a retry currently waiting on BUSY.
      const previousStatus = statusFlight.current;
      if (previousStatus) { previousStatus.controller.abort(); await previousStatus.promise; }
      const value = await platform.auth[method](args, {signal: controller.signal});
      if (method === 'signIn' && hosted) {
        // Native sign-in conceals the old hosted page until its cookie has been
        // replaced. Keep one operation owner through both bridge acknowledgments.
        try {
          await platform.auth.syncWebSession({}, {signal: controller.signal});
        } catch (failure) {
          // Attempt rollback even if the initiating signal was cancelled. A new
          // native session must not survive a failed web-session installation.
          // Native sign-out clears local credentials/cookies even when remote
          // revocation fails; the original synchronization failure is preserved.
          try { await platform.auth.signOut({}, {timeoutMs: 15000}); } catch { /* Native concealment remains authoritative if the document is gone. */ }
          reloadHosted();
          throw failure;
        }
        reloadHosted();
      }
      if (alive.current && version === generation.current && typeof value.authenticated === 'boolean') adoptSession(value);
      return value;
    } catch (failure) {
      if (alive.current && operation.current === token) setError(failure);
      throw failure;
    } finally {
      controllers.current.delete(controller);
      if (operation.current === token) {
        operation.current = null;
        if (alive.current) setBusy(false);
      }
    }
  }, [available, platform, adoptSession, hosted, reloadHosted]);

  return {session, available, loading, busy, error, refresh,
    signIn: useCallback(args => execute('signIn', args), [execute]),
    registerPasskey: useCallback(() => execute('registerPasskey'), [execute]),
    signOut: useCallback(async () => {
      const result = await execute('signOut');
      reloadHosted();
      return result;
    }, [execute, reloadHosted]),
    syncWebSession: useCallback(async () => {
      const result = await execute('syncWebSession');
      reloadHosted();
      return result;
    }, [execute, reloadHosted]),
  };
}
