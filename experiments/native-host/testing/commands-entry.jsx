import {page} from './webview-documents.mjs';
import React, {useLayoutEffect, useRef, useState} from 'react';
import {View, Text, TextInput, ScrollView, Pressable, WebView, dispatchEvent, render, snapshot} from '../js/renderer.js';

function Button({id, children, action}) {
  return <Pressable testID={id} accessibilityLabel={children} accessibilityRole="button" onPress={action}
    style={{width: '31%', height: 36, padding: 6, backgroundColor: '#dce8ff'}}>
    <Text style={{height: 24}}>{children}</Text>
  </Pressable>;
}
function Row({children}) { return <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 5, width: '100%'}}>{children}</View>; }

function InputCommands() {
  const input = useRef(null);
  const [focus, setFocus] = useState('pending');
  const [changes, setChanges] = useState(0);
  useLayoutEffect(() => { input.current.focus(); }, []);
  return <View style={{gap: 8}}>
    <TextInput ref={input} testID="cmd-input" accessibilityLabel="Command input" defaultValue="seed"
      onFocus={() => setFocus('focused')} onBlur={() => setFocus('blurred')}
      onChangeText={() => setChanges(value => value + 1)} style={{width: '100%', height: 42, borderWidth: 1}} />
    <Text testID="cmd-focus-state" style={{height: 24}}>Focus: {focus}</Text>
    <Text testID="cmd-change-count" style={{height: 24}}>Changes: {changes}</Text>
    <Row>
      <Button id="cmd-focus" action={() => input.current.focus()}>Focus</Button>
      <Button id="cmd-blur" action={() => input.current.blur()}>Blur</Button>
      <Button id="cmd-clear" action={() => input.current.clear()}>Clear</Button>
    </Row>
  </View>;
}

function ScrollCommands() {
  const scroll = useRef(null);
  const [offset, setOffset] = useState(0);
  return <View style={{gap: 8}}>
    <ScrollView ref={scroll} testID="cmd-scroll" onScroll={event => setOffset(Math.round(event.nativeEvent.contentOffset.y))}
      style={{height: 80, width: '100%', backgroundColor: '#e5e5e5'}}>
      <View style={{height: 400, width: '100%'}}>{Array.from({length: 12}, (_, i) =>
        <Text key={i} style={{height: 30}}>Scroll row {i}</Text>)}</View>
    </ScrollView>
    <Text testID="cmd-scroll-offset" style={{height: 24}}>Offset: {offset}</Text>
    <Row>
      <Button id="cmd-scroll-to" action={() => scroll.current.scrollTo({y: 160, animated: false})}>Scroll 160</Button>
      <Button id="cmd-scroll-end" action={() => scroll.current.scrollToEnd({animated: false})}>Scroll end</Button>
      <Button id="cmd-scroll-top" action={() => scroll.current.scrollTo({y: 0, animated: false})}>Scroll top</Button>
    </Row>
  </View>;
}

const source = name => globalThis.__nhPlatform === 'ios'
  ? {uri: `http://127.0.0.1:18789/${name}`}
  : page(name);
const sources = {A: source('A'), B: source('B'), secondary: source('secondary')};
function WebCommands() {
  const web = useRef(null);
  const [source, setSource] = useState('A');
  const [key, setKey] = useState(0);
  const [visible, setVisible] = useState(true);
  const [log, setLog] = useState('waiting');
  const [ready, setReady] = useState('waiting');
  const [secondary, setSecondary] = useState('waiting');
  const message = event => {
    const data = event.nativeEvent.data;
    if (data.startsWith('ready:')) setReady(data);
    else setLog(data);
  };
  return <View style={{gap: 5}}>
    <Text testID="cmd-web-ready" style={{height: 22}}>{ready}</Text>
    <Text testID="cmd-web-log" style={{height: 44}}>{log}</Text>
    <Row>
      <Button id="cmd-web-inject" action={() => web.current.injectJavaScript("window.NativeHost.postMessage('injected')")}>Inject</Button>
      <Button id="cmd-web-post" action={() => web.current.postMessage('quoted " 🦀')}>Post</Button>
      <Button id="cmd-web-back" action={() => web.current.goBack()}>Back</Button>
      <Button id="cmd-web-forward" action={() => web.current.goForward()}>Forward</Button>
      <Button id="cmd-web-reload" action={() => { setReady('waiting'); web.current.reload(); }}>Reload</Button>
      <Button id="cmd-web-same-history" action={() => web.current.injectJavaScript("window.historyMode='same';window.historyStep=0;window.NativeHost.postMessage('mode:same')")}>Same URL</Button>
      <Button id="cmd-web-path-history" action={() => web.current.injectJavaScript("window.historyMode='path';window.historyStep=0;window.NativeHost.postMessage('mode:path')")}>Path history</Button>
      <Button id="cmd-web-stop" action={() => web.current.stopLoading()}>Stop</Button>
      <Button id="cmd-web-source" action={() => { setReady('waiting'); setSource(value => value === 'A' ? 'B' : 'A'); }}>Source</Button>
      <Button id="cmd-web-replace" action={() => { setReady('waiting'); setKey(value => value + 1); }}>Replace</Button>
      <Button id="cmd-web-toggle" action={() => { setReady('waiting'); setVisible(value => !value); }}>Toggle web</Button>
    </Row>
    {visible && <WebView key={key} ref={web} testID="cmd-web-primary" source={sources[source]} onMessage={message} style={{height: 100, width: '100%'}} />}
    <WebView testID="cmd-web-secondary" source={sources.secondary} onMessage={event => setSecondary(event.nativeEvent.data)} style={{height: 100, width: '100%'}} />
    <Text testID="cmd-web-secondary-state" style={{height: 22}}>{secondary}</Text>
  </View>;
}

function CommandsDemo() {
  const [mode, setMode] = useState('input');
  return <View style={{padding: 10, width: '100%', gap: 8}}>
    <Text testID="heading" style={{height: 28, fontSize: 20}}>Native command contract</Text>
    <Row>
      <Button id="cmd-tab-input" action={() => setMode('input')}>Input tab</Button>
      <Button id="cmd-tab-scroll" action={() => setMode('scroll')}>Scroll tab</Button>
      <Button id="cmd-tab-web" action={() => setMode('web')}>Web tab</Button>
    </Row>
    {mode === 'input' ? <InputCommands /> : mode === 'scroll' ? <ScrollCommands /> : <WebCommands />}
  </View>;
}
globalThis.__nhDispatch = (method, params = {}) => {
  if (method === 'app.event') return dispatchEvent(params);
  if (method === 'ui.snapshot' && __NH_TEST_HOOKS__) return snapshot();
  throw new Error(`Unsupported command fixture method: ${method}`);
};
render(<CommandsDemo />);
