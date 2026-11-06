import {randomUUID} from 'node:crypto';
import {cookies, headers} from 'next/headers';
import {saveServerPreference} from './actions';
import {HostedControls} from './controls';
import {NativeLink} from '../../../../packages/platform-react/index.jsx';

export const dynamic = 'force-dynamic';

export default async function HostedPage() {
  const requestHeaders = await headers();
  const store = await cookies();
  const nonce = randomUUID();
  const preference = store.get('spa-demo-preference')?.value || 'none';
  return <main className="shell">
    <section className="page-heading"><p className="eyebrow">Rendered for this request</p><h1>Web delivery.<br /><em>Native presence.</em></h1><p>This page runs on the Next.js server. The bridge and native shell stay in the application.</p></section>
    <section className="editor-card hosted-proof">
      <h2>Server rendering proof</h2>
      <p>Request nonce: <code data-testid="server-nonce">{nonce}</code></p>
      <p>Rendered at: <time data-testid="server-time">{new Date().toISOString()}</time></p>
      <p>Request host: <span data-testid="server-host">{requestHeaders.get('host')}</span></p>
      <p>HttpOnly preference: <strong data-testid="server-preference">{preference}</strong></p>
      <form action={saveServerPreference} className="button-row">
        <button className="button" name="preference" value="forest">Save forest on server</button>
        <button className="button secondary" name="preference" value="ocean">Save ocean on server</button>
      </form>
    </section>
    <HostedControls />
    <p><NativeLink className="text-button" href="/hosted/item/42/">Visit server item 42 →</NativeLink></p>
  </main>;
}
