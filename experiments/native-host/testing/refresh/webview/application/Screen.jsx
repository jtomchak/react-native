import React, {useRef, useState} from 'react';
import {View, Text, Pressable, WebView} from '../../../../js/renderer.js';
import {sources} from '../documents.mjs';
import {REVISION} from './revision.js';

export default function Screen() {
  const bodyTag = 'original';
  const primary = useRef(null), secondary = useRef(null), sequence = useRef(0);
  const [reports, setReports] = useState({A: null, B: null});
  const [key, setKey] = useState(0);
  const [count, setCount] = useState(0);
  const receive = name => event => {
    const data = JSON.parse(event.nativeEvent.data);
    setReports(previous => ({...previous, [name]: {...data, handler: bodyTag}}));
  };
  const send = (ref, op, request) => ref.current.postMessage(JSON.stringify({op, request}));
  const probe = () => {
    const request = ++sequence.current;
    send(primary, 'probe', request); send(secondary, 'probe', request);
  };
  const button = (title, action) => <Pressable key={title} accessibilityLabel={title} accessibilityRole="button" onPress={action}
    style={{width: 100, height: 36, padding: 4, backgroundColor: '#dce8ff'}}><Text style={{height: 26}}>{title}</Text></Pressable>;
  return <View style={{width: 340, height: 620, padding: 8, gap: 4}}>
    <Text testID="browser-revision" style={{height: 28}}>Revision: {REVISION}</Text>
    <Text testID="browser-count" style={{height: 24}}>Native count: {count}</Text>
    <View style={{flexDirection: 'row', gap: 4, height: 36}}>
      {button('Seed A', () => send(primary, 'seed', ++sequence.current))}
      {button('Seed B', () => send(secondary, 'seed', ++sequence.current))}
      {button('Probe both', probe)}
    </View>
    <View style={{flexDirection: 'row', gap: 4, height: 36}}>
      {button('Native update', () => setCount(value => value + 1))}
      {button('Replace A', () => setKey(value => value + 1))}
    </View>
    <WebView key={key} ref={primary} testID="browser-A" source={sources.A} onMessage={receive('A')} style={{width: 320, height: 90}} />
    <Text testID="report-A" style={{width: 320, height: 100, fontSize: 11}}>{reports.A ? JSON.stringify(reports.A) : 'waiting-A'}</Text>
    <WebView ref={secondary} testID="browser-B" source={sources.B} onMessage={receive('B')} style={{width: 320, height: 90}} />
    <Text testID="report-B" style={{width: 320, height: 100, fontSize: 11}}>{reports.B ? JSON.stringify(reports.B) : 'waiting-B'}</Text>
  </View>;
}
