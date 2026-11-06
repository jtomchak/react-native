'use client';

import {NativeLink, NativeToolbar} from '../../../../packages/platform-react/index.jsx';

export function HostedControls({title = 'Hosted Next.js'}) {
  return <>
    <NativeToolbar title={title} actions={[]} />
    <div className="button-row">
      <NativeLink className="button" href="/compose/">Visit Compose natively</NativeLink>
      <NativeLink className="button secondary" href="/library/" presentation="modal">Present Library</NativeLink>
      <NativeLink className="text-button" href="/">Return to overview</NativeLink>
    </div>
  </>;
}
