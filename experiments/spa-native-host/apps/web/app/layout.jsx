import Script from 'next/script';
import {Suspense} from 'react';
import {PlatformProvider} from '../components/platform';
import './style.css';

export const metadata = {title: 'Native actions', description: 'A Next.js SPA connected to our own native host.'};

export default function RootLayout({children}) {
  return <html lang="en"><body>
    <Script src="/platform-sdk.js" strategy="beforeInteractive" />
    <Suspense fallback={<main className="shell"><p>Opening application…</p></main>}>
      <PlatformProvider>{children}</PlatformProvider>
    </Suspense>
  </body></html>;
}
