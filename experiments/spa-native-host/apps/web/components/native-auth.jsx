'use client';

import {useEffect, useRef, useState} from 'react';
import {NativeLink, usePlatform, useAuth} from './platform';
import {Button} from './interface';

export function NativeAuth() {
  const {capabilities} = usePlatform();
  const auth = useAuth();
  const [notice, setNotice] = useState(null);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const hosted = capabilities?.host?.contentMode === 'hosted';
  const providers = auth.session?.providers || [];
  const signedIn = auth.session?.authenticated === true;
  const enabled = auth.available && auth.session?.configured === true;
  const disabled = auth.busy || auth.loading || !enabled;
  const perform = async (operation, message) => {
    setNotice(null);
    try {
      const result = await operation();
      if (alive.current) setNotice(result.revoked === false ? 'Signed out locally. Server revocation could not be confirmed.' : message);
    } catch { /* useAuth renders the typed native failure below. */ }
  };
  return <>
    <div className="section-label"><h2>Native authentication</h2><span>09</span></div>
    <section className="quiet-card" aria-label="Native authentication"><div>
      <p className="eyebrow">One identity across native and web</p>
      <h2>{signedIn ? `Signed in as ${auth.session.user.name || auth.session.user.id}` : 'OAuth and passkeys, presented natively.'}</h2>
      <p data-testid="auth-status">{auth.loading ? 'Checking native session…' : !auth.available ? 'Open a compatible native host to authenticate.' : !enabled ? 'Authentication is not configured. Add an approved service origin and providers to the host.' : signedIn ? hosted ? 'Native and web sign-in share this account. Refresh the web session if needed.' : 'A native session is active.' : hosted ? 'No native session is active. Signing in also establishes the web session and reloads server content.' : 'No native session is active.'}</p>
      <div className="button-row">
        {providers.map(provider => <Button key={provider} disabled={disabled || signedIn} onClick={() => perform(() => auth.signIn({method: 'oauth', provider}), hosted ? 'Native and web OAuth sign-in completed.' : 'Native OAuth sign-in completed.')}>Sign in with {provider}</Button>)}
        <Button secondary disabled={disabled || signedIn || !auth.session?.passkeys} onClick={() => perform(() => auth.signIn({method: 'passkey'}), hosted ? 'Native and web passkey sign-in completed.' : 'Native passkey sign-in completed.')}>Sign in with a passkey</Button>
        <Button secondary disabled={disabled || !signedIn || !auth.session?.passkeys} onClick={() => perform(auth.registerPasskey, 'Passkey registered for this account.')}>Add a passkey</Button>
        <Button secondary disabled={disabled || !signedIn} onClick={() => perform(auth.signOut, 'Native and linked web sessions signed out.')}>Sign out</Button>
      </div>
      <div className="button-row">
        <Button secondary disabled={!auth.available || auth.busy || auth.loading} onClick={() => { setNotice(null); auth.refresh(); }}>Refresh session status</Button>
        {hosted && <Button secondary disabled={disabled || !signedIn} onClick={() => perform(auth.syncWebSession, 'Web session installed. Reloading server content.')}>Sync web session</Button>}
      </div>
      {hosted && <p><NativeLink className="text-button" href="/hosted/auth/">Inspect server session →</NativeLink></p>}
      {!hosted && enabled && <p>The packaged SPA uses native session operations. Web cookie synchronization is available in hosted mode.</p>}
      {auth.busy && <p className="notice" role="status">Waiting for native authentication…</p>}
      {auth.error && <p className="notice error" role="alert">{auth.error.code || 'IO_ERROR'}: {auth.error.message}</p>}
      {notice && <p className="notice" role="status" data-testid="auth-notice">{notice}</p>}
    </div></section>
  </>;
}
