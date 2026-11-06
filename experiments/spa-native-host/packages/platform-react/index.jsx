'use client';

import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {createHistoryLedger, subscribeHistoryUpdates} from './history-ledger.mjs';

const PlatformContext = createContext({platform: null, capabilities: null, connection: 'connecting', error: null});

export function PlatformProvider({children}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const route = `${pathname}${search.toString() ? `?${search}` : ''}`;
  const [state, setState] = useState({platform: null, capabilities: null, connection: 'connecting', error: null});
  const [historyVersion, setHistoryVersion] = useState(0);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  const ledger = useRef(null);
  const back = useRef(null);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const title = pathname === '/compose/' || pathname === '/compose' ? 'Compose' : pathname === '/library/' || pathname === '/library' ? 'Your library' : pathname === '/hosted/' || pathname === '/hosted' ? 'Hosted Next.js' : 'Native actions';

  useEffect(() => {
    let active = true;
    const history = createHistoryLedger(window);
    ledger.current = history;
    const unsubscribeHistory = subscribeHistoryUpdates(history, () => setHistoryVersion(version => version + 1));
    const api = window.platform;
    let unsubscribeActivation = null;
    if (!api) {
      setState({platform: null, capabilities: null, connection: 'unavailable', error: {code: 'UNAVAILABLE', message: 'Platform SDK has not loaded.'}});
      return () => { active = false; unsubscribeHistory(); history.dispose(); ledger.current = null; };
    }
    const unsubscribeBack = api.on('navigation.back', ({token}) => {
      if (typeof token !== 'string' || back.current || history.index <= 0) return;
      const pending = {token, expectedIndex: history.index - 1, from: currentRoute.current};
      back.current = pending;
      // The native coordinator owns its five-second timeout. Forget a timed-out
      // token locally too, so subsequent requests cannot be permanently blocked.
      pending.timer = setTimeout(() => { if (back.current === pending) back.current = null; }, 5000);
      router.back();
    });
    api.ready().then(capabilities => {
      if (!active) return;
      setState({platform: api, capabilities, connection: 'connected', error: null});
      if (capabilities.capabilities.includes('events.subscribe')) unsubscribeActivation = api.on('navigation.changed', event => {
        if (!active || event.reason !== 'activated') return;
        if (event.host && event.host.surfaceId === capabilities.host?.surfaceId) {
          setState(previous => ({...previous, capabilities: {...previous.capabilities, host: {...previous.capabilities.host, ...event.host}}, error: null}));
        }
        setForegroundEpoch(value => value + 1);
      });
    }, error => {
      if (active) setState({platform: api, capabilities: null, connection: 'unavailable', error});
    });
    return () => {
      active = false;
      unsubscribeBack();
      unsubscribeActivation?.();
      unsubscribeHistory();
      history.dispose();
      ledger.current = null;
      if (back.current) clearTimeout(back.current.timer);
      back.current = null;
    };
  }, [router]);

  useEffect(() => {
    if (state.connection !== 'connected' || !ledger.current) return;
    // Router state and the browser URL must agree before native sees a commit.
    // A popstate notification can arrive before React has committed its route.
    if (`${window.location.pathname}${window.location.search}` !== route) return;
    const pending = back.current;
    const ack = pending && ledger.current.index === pending.expectedIndex ? pending.token : undefined;
    state.platform.navigation.update({path: route, title, canGoBack: ledger.current.index > 0, ...(ack ? {ack} : {})}).then(() => {
      if (ack && back.current === pending) {
        clearTimeout(pending.timer);
        back.current = null;
      }
    }, error => {
      // Keep route content usable and make a native synchronization failure
      // visible in the diagnostics panel rather than claiming navigation passed.
      setState(previous => ({...previous, error}));
    });
  }, [route, title, historyVersion, foregroundEpoch, state.connection, state.platform]);

  return <PlatformContext.Provider value={{...state, foregroundEpoch}}>{children}</PlatformContext.Provider>;
}

export function usePlatform() { return useContext(PlatformContext); }

export function NativeLink({href, presentation = 'push', onClick, onNativeError, children, ...props}) {
  const {platform, capabilities, connection} = usePlatform();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const click = event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target && props.target !== '_self' || props.download !== undefined) return;
    const native = connection === 'connected' && capabilities?.host?.navigationMode === 'native' && capabilities.capabilities.includes('navigation.visit') && typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
    if (!native) return;
    event.preventDefault();
    if (pending) return;
    setPending(true); setFailure(null);
    platform.navigation.visit({path: href, presentation}).catch(error => {
      if (alive.current) setFailure(error);
      onNativeError?.(error);
    }).finally(() => { if (alive.current) setPending(false); });
  };
  return <>
    <Link href={href} {...props} aria-busy={pending || undefined} onClick={click}>{children}</Link>
    {failure && <span className="notice error" role="alert">{failure.code}: {failure.message}</span>}
  </>;
}

export function useNativeAction() {
  const {platform, connection} = usePlatform();
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const controllers = useRef(new Set());
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, []);
  const run = useCallback(async operation => {
    if (connection !== 'connected' || !platform) {
      const unavailable = {code: 'UNAVAILABLE', message: 'Open this screen in the iOS or Android host to use native actions.'};
      if (live.current) setResult({ok: false, ...unavailable});
      return undefined;
    }
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    try {
      const value = await operation(platform, {signal: controller.signal});
      if (live.current) setResult({ok: true, value: value === undefined ? null : value});
      return value;
    } catch (error) {
      if (live.current) setResult({ok: false, code: error.code || 'IO_ERROR', message: error.message});
      return undefined;
    } finally {
      controllers.current.delete(controller);
      if (live.current) setBusy(controllers.current.size > 0);
    }
  }, [connection, platform]);
  return {run, result, busy};
}

export function NativeToolbar({title, actions = []}) {
  const {platform, connection, foregroundEpoch} = usePlatform();
  const callbacks = useRef(actions);
  callbacks.current = actions;
  const registration = useRef(null);
  if (!registration.current) registration.current = `toolbar-${Math.random().toString(36).slice(2)}`;
  const signature = JSON.stringify(actions.map(({id, title: actionTitle}) => ({id, title: actionTitle})));
  useEffect(() => {
    if (connection !== 'connected' || !platform) return;
    const controller = new AbortController();
    const owner = registration.current;
    const unsubscribe = platform.on('toolbar.action', event => {
      if (event.registration !== owner) return;
      const action = callbacks.current.find(candidate => candidate.id === event.id);
      if (action && typeof action.onPress === 'function') action.onPress();
    });
    platform.toolbar.set({registration: owner, title, actions: JSON.parse(signature)}, {signal: controller.signal}).catch(() => {});
    return () => {
      controller.abort();
      unsubscribe();
      // A stale clear cannot remove another route's registration on the host.
      platform.toolbar.clear({registration: owner}).catch(() => {});
    };
  }, [connection, platform, title, signature, foregroundEpoch]);
  return null;
}
