import {cookies} from 'next/headers';
import {authService, cookieName} from '../../../lib/auth.mjs';
import {NativeAuth} from '../../../../web/components/native-auth.jsx';
export const dynamic = 'force-dynamic';
export default async function AuthenticatedPage() {
  let session = {authenticated: false};
  let configured = false;
  try {
    const service = await authService();
    if (service) { configured = true; session = service.web((await cookies()).get(cookieName(service))?.value); }
  } catch { /* Unconfigured auth must not grant access or expose server settings. */ }
  return <main className="shell">
    <section className="editor-card">
      <h1>Native authentication</h1>
      <p data-testid="auth-server-status">{session.authenticated ? `Server authenticated: ${session.user.name}` : 'Server anonymous'}</p>
      <p>{configured ? 'This identity was resolved on the Next.js server from its HttpOnly session cookie.' : 'Configure the authentication service to enable live sign-in.'}</p>
      {session.authenticated && <p data-testid="auth-server-user">{session.user.id}</p>}
    </section>
    <NativeAuth />
  </main>;
}
