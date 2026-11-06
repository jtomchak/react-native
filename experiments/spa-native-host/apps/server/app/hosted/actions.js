'use server';

import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';

export async function saveServerPreference(formData) {
  const preference = formData.get('preference');
  if (preference !== 'forest' && preference !== 'ocean') throw new Error('Invalid preference');
  const store = await cookies();
  store.set('spa-demo-preference', preference, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 3600,
    // Only explicit HTTP-loopback test tooling disables Secure. Production
    // HTTPS origins use Secure cookies by default.
    secure: process.env.SPA_SECURE_COOKIES !== '0',
  });
  redirect('/hosted/');
}
