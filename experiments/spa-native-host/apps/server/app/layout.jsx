import Script from 'next/script';
import {Suspense} from 'react';
import {PlatformProvider} from '../../../packages/platform-react/index.jsx';
import '../../web/app/style.css';

export const metadata = {title: 'Hosted native actions', description: 'Server-rendered Next.js with our own native host.'};
export default function Layout({children}) {
  return <html lang="en"><body>
    <Script src="/platform-sdk.js" strategy="beforeInteractive" />
    <Suspense fallback={<main className="shell"><p>Opening application…</p></main>}>
      <PlatformProvider>{children}</PlatformProvider>
    </Suspense>
  </body></html>;
}
