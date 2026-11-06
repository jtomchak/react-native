'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {usePlatform} from './platform';

export function Shell({eyebrow, title, description, children}) {
  const pathname = usePathname();
  const {connection, capabilities, error} = usePlatform();
  const nativeChrome = connection === 'connected' && capabilities?.host?.chromeMode && capabilities.host.chromeMode !== 'standard';
  const active = pathname === '/compose/' || pathname === '/compose' ? 'compose' : pathname === '/library/' || pathname === '/library' ? 'library' : 'home';
  return <main className="shell">
    <header className="masthead"><Link href="/" className="brand" aria-label="Native actions home"><span className="brand-mark" aria-hidden="true">n<span>·</span></span><span>Native actions</span></Link><span className={`connection ${connection}`} data-testid="connection"><i />{connection === 'connected' ? capabilities.platform === 'ios' ? 'iOS host' : 'Android host' : connection === 'connecting' ? 'Connecting' : 'Browser preview'}</span></header>
    {!nativeChrome && <nav className="navigation" aria-label="Application"><Link href="/" data-analytics-id="navigation.overview" aria-current={active === 'home' ? 'page' : undefined}>Overview</Link><Link href="/compose/" data-analytics-id="navigation.compose" aria-current={active === 'compose' ? 'page' : undefined}>Compose</Link><Link href="/library/" data-analytics-id="navigation.library" aria-current={active === 'library' ? 'page' : undefined}>Library</Link></nav>}
    <section className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></section>
    {connection === 'unavailable' && <aside className="notice" role="status">You’re viewing the web app. Open it in our iOS or Android host to use native actions.</aside>}
    {connection === 'connected' && error && <aside className="notice error" role="alert">Native synchronization: {error.code} — {error.message}</aside>}
    {children}
    <footer className="footer"><span>One application. Two worlds.</span><span>Prototype / 01</span></footer>
  </main>;
}

export function Result({result, busy}) {
  if (busy) return <p className="result pending" role="status">Waiting for native action…</p>;
  if (!result) return null;
  return <div className={`result ${result.ok ? 'success' : 'failure'}`} role="status" data-testid="action-result"><strong>{result.ok ? 'Action complete' : result.code}</strong><span>{result.ok ? result.value === null ? 'The native host acknowledged this action.' : typeof result.value === 'string' ? result.value : JSON.stringify(result.value) : result.message}</span></div>;
}

export function Button({children, secondary = false, ...props}) {
  return <button className={secondary ? 'button secondary' : 'button'} {...props}>{children}</button>;
}
