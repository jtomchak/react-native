'use client';

import {useCallback, useEffect, useState} from 'react';
import {NativeToolbar, useNativeAction, usePlatform, useStorageUnavailable, requireStorage} from '../../components/platform';
import {Button, Result, Shell} from '../../components/interface';

export default function Library() {
  const {platform, connection} = usePlatform();
  const {run, result, busy} = useNativeAction();
  const storageUnavailable = useStorageUnavailable();
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (connection !== 'connected' || storageUnavailable) return;
    const controller = new AbortController();
    (async () => {
      const value = await platform.storage.get('last-photo', {signal: controller.signal});
      if (value) {
        const saved = JSON.parse(value);
        if (!saved || typeof saved.file !== 'string') throw new Error('Saved photo metadata is invalid.');
        const url = await platform.files.previewURL(saved.file, {signal: controller.signal});
        if (!controller.signal.aborted) { setPhoto(saved); setPreview(url); }
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [platform, connection, storageUnavailable]);
  const capture = useCallback(() => run(async (api, options) => {
    const storage = await requireStorage(api);
    const next = await api.camera.capture({}, options);
    const url = await api.files.previewURL(next.file, options);
    await storage.set('last-photo', JSON.stringify(next), options);
    if (!options.signal.aborted) { setPhoto(next); setPreview(url); setError(null); }
    return 'Photo captured and saved.';
  }), [run]);
  const remove = () => run(async (api, options) => {
    const storage = await requireStorage(api);
    await api.files.remove(photo.file, options);
    await storage.remove('last-photo', options);
    if (!options.signal.aborted) { setPhoto(null); setPreview(null); }
    return 'Photo removed from this application.';
  });
  return <Shell eyebrow="Captured on your device" title={<>A moment, <br /><em>made yours.</em></>} description="The camera belongs to the platform. The result belongs in your application.">
    <NativeToolbar title="Your library" actions={storageUnavailable ? [] : [{id: 'capture', title: 'Capture', onPress: capture}]} />
    {preview ? <figure className="photo-preview"><img src={preview} alt="Your last captured photo" /><figcaption>Native capture · {photo.mimeType}</figcaption></figure> : <section className="empty-state"><span className="empty-camera" aria-hidden="true">◎</span><h2>A place for your next photo.</h2><p>Open the native camera to capture your first moment.</p><Button onClick={capture} disabled={busy || storageUnavailable}>Take a photo <span aria-hidden="true">↗</span></Button></section>}
    {storageUnavailable && <p role="status" className="notice">Native storage is unavailable in this app.</p>}
    {error && <p className="notice error" role="alert">Could not open the saved photo: {error.code || error.message}</p>}
    {photo && <div className="button-row"><Button onClick={capture} disabled={busy || storageUnavailable}>Take another photo</Button><Button secondary onClick={remove} disabled={busy || storageUnavailable}>Remove this photo</Button></div>}
    <Result result={result} busy={busy} />
  </Shell>;
}
