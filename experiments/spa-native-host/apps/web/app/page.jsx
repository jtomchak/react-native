'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {NativeToolbar, useNativeAction, useStorageUnavailable, requireStorage} from '../components/platform';
import {Button, Result, Shell} from '../components/interface';
import {NativeIntegrations} from '../components/native-integrations';

export default function Home() {
  const router = useRouter();
  const {run, result, busy} = useNativeAction();
  const storageUnavailable = useStorageUnavailable();
  const [preview, setPreview] = useState(null);
  const capture = () => run(async (api, options) => {
    const storage = await requireStorage(api);
    const photo = await api.camera.capture({}, options);
    await storage.set('last-photo', JSON.stringify(photo), options);
    const url = await api.files.previewURL(photo.file, options);
    if (!options.signal.aborted) setPreview(url);
    return {file: photo.file, message: 'Photo saved to your library.'};
  });
  return <Shell eyebrow="Web content. Native capability." title={<>Built for <br /><em>both worlds.</em></>} description="A small web application with a direct connection to the device around it.">
    <NativeToolbar title="Native actions" actions={[{id: 'compose', title: 'Compose', onPress: () => router.push('/compose/') }]} />
    <section className="hero-card"><span className="hero-orb" aria-hidden="true" /><div className="hero-content"><span className="chip">OUR HOST · OUR BRIDGE</span><h2>The browser is<br />just the beginning.</h2><p>Capture a moment, feel a response, or open a native sheet. Each action crosses our own platform bridge.</p><Button onClick={() => run((api, options) => api.navigation.present({screen: 'native-demo'}, options))} disabled={busy}>Open native sheet <span aria-hidden="true">↗</span></Button></div></section>
    <div className="section-label"><h2>Try the connection</h2><span>01—04</span></div>
    <section className="action-grid" aria-label="Native capabilities">
      <article className="action-card"><span className="icon" aria-hidden="true">↗</span><span className="card-index">01</span><h3>Navigation</h3><p>Keep the page in place. Let the host handle native presentation.</p><button className="text-button" onClick={() => run((api, options) => api.navigation.present({screen: 'native-demo'}, options))} disabled={busy}>Present a sheet <span aria-hidden="true">→</span></button></article>
      <article className="action-card"><span className="icon" aria-hidden="true">≈</span><span className="card-index">02</span><h3>Haptics</h3><p>A small physical response, delivered by the device.</p><button className="text-button" onClick={() => run((api, options) => api.haptics.impact({style: 'light'}, options))} disabled={busy}>Feel a light impact <span aria-hidden="true">→</span></button></article>
      <article className="action-card"><span className="icon" aria-hidden="true">◎</span><span className="card-index">03</span><h3>Camera</h3><p>{storageUnavailable ? 'Native storage is unavailable, so photo saving is disabled.' : 'Use the native camera. Bring a managed photo back into the page.'}</p><button className="text-button" onClick={capture} disabled={busy || storageUnavailable}>Take a photo <span aria-hidden="true">→</span></button></article>
      <article className="action-card"><span className="icon" aria-hidden="true">▤</span><span className="card-index">04</span><h3>Storage</h3><p>A draft that stays with your application, even after a restart.</p><button className="text-button" onClick={() => router.push('/compose/')}>Write a draft <span aria-hidden="true">→</span></button></article>
    </section>
    <Result result={result} busy={busy} />
    <NativeIntegrations />
    {preview && <figure className="photo-preview"><img src={preview} alt="Your captured photo" /><figcaption>Captured by the native camera</figcaption></figure>}
    <section className="quiet-card"><div><p className="eyebrow">A small, open contract</p><h2>Native actions, from ordinary HTML.</h2><p>The same SDK works without React or Next.js.</p></div><a className="text-button" href="/plain.html">Open HTML fixture <span aria-hidden="true">↗</span></a></section>
  </Shell>;
}
