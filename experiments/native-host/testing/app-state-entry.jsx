import React, {useLayoutEffect, useRef, useState} from 'react';
import {View, Text, Pressable, dispatchEvent, render, snapshot} from '../js/renderer.js';
import {getAppState, subscribeAppState} from '../js/services.js';

const instance = `${globalThis.__nhGeneration}:${Date.now()}:${Math.random()}`;
function AppStateFixture() {
  const [events, setEvents] = useState([]);
  const [captured, setCaptured] = useState(null);
  const [current, setCurrent] = useState('starting');
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState('none');
  const subscription = useRef(null);
  const requests = useRef(new Set());
  const live = useRef(false);
  const latest = useRef(-1);
  const serial = useRef(0);
  const acceptCurrent = value => {
    if (value.sequence >= latest.current) {
      latest.current = value.sequence;
      setCurrent(value.state);
    }
  };
  const capture = () => {
    try {
      const request = getAppState();
      const number = ++serial.current;
      requests.current.add(request);
      request.promise.then(value => {
        if (!live.current) return;
        setCaptured({...value, snapshotSerial: number});
        acceptCurrent(value);
      }, failure => { if (live.current) setError(String(failure.code || failure.message)); })
        .finally(() => requests.current.delete(request));
    } catch (failure) { setError(String(failure.code || failure.message)); }
  };
  useLayoutEffect(() => {
    live.current = true;
    try {
      subscription.current = subscribeAppState(value => {
        if (!live.current) return;
        setEvents(values => [...values, value].slice(-32));
        acceptCurrent(value);
      });
      setSubscribed(true);
      capture();
    } catch (failure) { setError(String(failure.code || failure.message)); }
    return () => {
      live.current = false;
      subscription.current?.unsubscribe();
      for (const request of requests.current) request.cancel();
      requests.current.clear();
    };
  }, []);
  const stop = () => {
    subscription.current?.unsubscribe();
    subscription.current = null;
    setSubscribed(false);
  };
  return <View style={{padding: 14, width: '100%', gap: 6}}>
    <Text testID="heading" style={{height: 28}}>Native AppState contract</Text>
    <Text testID="as-capability" style={{height: 24}}>{String(globalThis.__nhAppStateAvailable)}</Text>
    <Text testID="as-instance" style={{height: 36}}>{instance}</Text>
    <Text testID="as-current" style={{height: 24}}>{current}</Text>
    <Text testID="as-subscribed" style={{height: 24}}>{String(subscribed)}</Text>
    <Text testID="as-error" style={{height: 24}}>{error}</Text>
    <Pressable testID="as-snapshot-button" accessibilityLabel="Capture AppState" onPress={capture}
      style={{height: 44, backgroundColor: '#dce8ff', padding: 8}}><Text style={{height: 24}}>Capture snapshot</Text></Pressable>
    <Pressable testID="as-unsubscribe" accessibilityLabel="Unsubscribe AppState" onPress={stop}
      style={{height: 44, backgroundColor: '#dce8ff', padding: 8}}><Text style={{height: 24}}>Unsubscribe</Text></Pressable>
    <Text testID="as-snapshot" style={{height: 110}}>{JSON.stringify(captured)}</Text>
    <Text testID="as-events" style={{height: 180}}>{JSON.stringify(events)}</Text>
  </View>;
}
globalThis.__nhDispatch = (method, params = {}) => {
  if (method === 'app.event') return dispatchEvent(params);
  if (method === 'ui.snapshot' && __NH_TEST_HOOKS__) return snapshot();
  throw new Error(`Unsupported AppState fixture method: ${method}`);
};
render(<AppStateFixture />);
