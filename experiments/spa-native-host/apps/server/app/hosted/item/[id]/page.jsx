import {randomUUID} from 'node:crypto';
import {notFound} from 'next/navigation';
import {HostedControls} from '../../controls';

export const dynamic = 'force-dynamic';

export default async function HostedItem({params}) {
  const {id} = await params;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  return <main className="shell">
    <section className="page-heading">
      <p className="eyebrow">A server-owned destination</p>
      <h1>Item <em data-testid="server-item-id">{id}</em></h1>
      <p>The server resolved this dynamic route at request time. It was not enumerated in the packaged application.</p>
    </section>
    <section className="editor-card hosted-proof">
      <h2>Dynamic route proof</h2>
      <p>Request nonce: <code data-testid="server-nonce">{randomUUID()}</code></p>
      <p>Rendered at: <time data-testid="server-time">{new Date().toISOString()}</time></p>
    </section>
    <HostedControls title={`Item ${id}`} />
  </main>;
}
