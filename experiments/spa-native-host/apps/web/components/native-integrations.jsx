'use client';

import {useEffect, useState} from 'react';
import {NativeLink, useNativeAction, usePlatform} from './platform';
import {Button, Result} from './interface';
import {NativeAuth} from './native-auth';

export function NativeIntegrations() {
  const {platform, capabilities, connection} = usePlatform();
  const {run, result, busy} = useNativeAction();
  const [event, setEvent] = useState(null);
  useEffect(() => {
    if (connection !== 'connected' || !capabilities.capabilities.includes('events.subscribe')) return;
    const stop = ['notifications.received', 'notifications.opened', 'links.opened'].map(name => platform.on(name, data => {
      // Render only routing metadata. Device tokens and full remote payloads
      // are not added to the page or console by the demonstration UI.
      setEvent({name, path: typeof data.path === 'string' ? data.path : null});
    }));
    return () => stop.forEach(dispose => dispose());
  }, [platform, capabilities, connection]);
  const nativeMode = capabilities?.host?.navigationMode === 'native';
  const hosted = capabilities?.host?.contentMode === 'hosted';
  const chrome = capabilities?.host?.chromeMode || 'standard';
  return <>
    <div className="section-label"><h2>Native navigation &amp; system actions</h2><span>05—08</span></div>
    <section className="quiet-card"><div>
      <p className="eyebrow">One interaction owner</p><h2>{nativeMode ? 'Native visits are enabled.' : 'Web navigation is active.'}</h2>
      <p>{nativeMode ? 'These links ask the host to push or present a native screen. Ordinary application links keep their web behavior.' : 'These links behave as ordinary Next.js links. Enable native visits in the host to use native screen transitions.'}</p>
      <div className="button-row"><NativeLink className="text-button" href="/compose/">Push Compose →</NativeLink><NativeLink className="text-button" href="/library/" presentation="modal">Present Library ↗</NativeLink></div>
      {hosted && <p><NativeLink className="text-button" href="/hosted/">Open server-rendered proof →</NativeLink></p>}
    </div></section>
    <section className="action-grid" aria-label="Additional native integrations">
      <article className="action-card"><span className="icon" aria-hidden="true">◉</span><h3>Notifications</h3><p>OS permission and provider registration. Real delivery requires your APNs or FCM setup.</p>
        <button className="text-button" disabled={busy} onClick={() => run((api, options) => api.notifications.status({}, options))}>Check notification status →</button>
        <button className="text-button" disabled={busy} onClick={() => run((api, options) => api.notifications.requestPermission({}, options))}>Request permission →</button>
        <button className="text-button" disabled={busy} onClick={() => run(async (api, options) => {
          const registration = await api.notifications.register({}, options);
          return {provider: registration.provider, environment: registration.environment, registered: typeof registration.token === 'string' && registration.token.length > 0};
        })}>Register for push →</button>
      </article>
      <article className="action-card"><span className="icon" aria-hidden="true">↗</span><h3>Deep links</h3><p>Cold and warm links enter the same native navigation coordinator.</p>
        <button className="text-button" disabled={busy} onClick={() => run((api, options) => api.links.getInitial({}, options))}>Read initial link →</button>
        <a className="text-button" href="spahost://app/compose/">Open Compose deep link ↗</a>
      </article>
      <article className="action-card"><span className="icon" aria-hidden="true">↑</span><h3>System sharing</h3><p>Use the device’s share sheet. Presentation and recipient delivery are different results.</p>
        <button className="text-button" disabled={busy} onClick={() => run((api, options) => api.share.present({text: 'Shared from our native host.', url: 'https://nextjs.org/'}, options))}>Open share sheet →</button>
      </article>
      <article className="action-card"><span className="icon" aria-hidden="true">◎</span><h3>Biometrics</h3><p>Authentication requires the platform’s success callback and your presence.</p>
        <button className="text-button" disabled={busy} onClick={() => run((api, options) => api.biometrics.status({}, options))}>Check biometric availability →</button>
        <button className="text-button" disabled={busy} onClick={() => run((api, options) => api.biometrics.authenticate({reason: 'Confirm your presence for the native actions prototype.'}, options))}>Authenticate →</button>
      </article>
    </section>
    {chrome !== 'standard' && <section className="quiet-card"><div><p className="eyebrow">Platform-owned chrome</p><h2>Tabs and navigation belong to the host.</h2><div className="button-row">
      <Button secondary disabled={busy} onClick={() => run((api, options) => api.chrome.state({}, options))}>Inspect native chrome</Button>
      <Button secondary disabled={busy} onClick={() => run((api, options) => api.chrome.selectTab({id: 'compose'}, options))}>Select Compose tab</Button>
    </div></div></section>}
    {event && <p className="notice" role="status" data-testid="native-event">Native event: {event.name}{event.path ? ` · ${event.path}` : ''}</p>}
    <Result result={result} busy={busy} />
    <NativeAuth />
  </>;
}
