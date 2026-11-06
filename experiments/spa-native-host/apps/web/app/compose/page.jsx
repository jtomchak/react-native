'use client';

import {useEffect, useState} from 'react';
import {NativeToolbar, useNativeAction, usePlatform} from '../../components/platform';
import {Button, Result, Shell} from '../../components/interface';

export default function Compose() {
  const {platform, connection} = usePlatform();
  const {run, result, busy} = useNativeAction();
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (connection !== 'connected') return;
    const controller = new AbortController();
    platform.storage.get('draft', {signal: controller.signal}).then(value => {
      if (!controller.signal.aborted) { setDraft(value || ''); setLoaded(true); }
    }, error => { if (!controller.signal.aborted) { setLoadError(error); setLoaded(true); } });
    return () => controller.abort();
  }, [platform, connection]);
  const save = () => run(async (api, options) => {
    await api.storage.set('draft', draft, options);
    if (!options.signal.aborted) setSaved(true);
    return 'Draft committed to native storage.';
  });
  const remove = () => run(async (api, options) => {
    await api.storage.remove('draft', options);
    if (!options.signal.aborted) { setDraft(''); setSaved(false); }
    return 'Saved draft removed.';
  });
  const editable = connection === 'unavailable' || loaded;
  return <Shell eyebrow="Persistent by design" title={<>A thought <br /><em>worth keeping.</em></>} description="Write something here. Save it through the native bridge, close the application, and find it waiting when you return.">
    <NativeToolbar title="Compose" actions={[{id: 'save', title: 'Save', onPress: save}]} />
    <section className="editor-card"><div className="editor-heading"><label htmlFor="draft">Your draft</label><span className={saved ? 'saved-indicator' : ''}>{saved ? 'Saved on device' : `${draft.length.toLocaleString()} characters`}</span></div><textarea id="draft" data-testid="draft" data-analytics-id="draft.input" placeholder="Start with a small idea…" value={draft} disabled={!editable || busy} maxLength={16000} onChange={event => {setDraft(event.target.value); setSaved(false);}} /><div className="editor-footer"><span>Private to this application</span><span>Native storage</span></div></section>
    {loadError && <p role="alert" className="notice error">Could not read the saved draft: {loadError.code}</p>}
    <div className="button-row"><Button data-analytics-id="draft.save" onClick={save} disabled={busy || !editable}>Save draft <span aria-hidden="true">↗</span></Button><Button data-analytics-id="draft.remove" secondary onClick={remove} disabled={busy || !editable}>Remove saved draft</Button></div>
    <Result result={result} busy={busy} />
    <section className="quiet-card"><div><p className="eyebrow">An explicit boundary</p><h2>Saved means committed.</h2><p>This screen waits for the native storage transaction. A browser preview does not simulate persistence.</p></div></section>
  </Shell>;
}
