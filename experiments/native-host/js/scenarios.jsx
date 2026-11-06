import React, {Suspense, startTransition, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, WebView, render} from './renderer.js';

let result = {};
let action = () => { throw new Error('No scenario action'); };

function AtomicLayout() {
  const [value, setValue] = useState(0);
  const ref = useRef(null);
  useLayoutEffect(() => {
    result.effects.push(value);
    result.geometry.push(ref.current.getBoundingClientRect());
    if (value === 0) setValue(1);
  }, [value]);
  return <View ref={ref} testID="atomic" style={{width: value ? 120 : 60, height: 40}}>
    <Text style={{height: 20}}>Value: {value}</Text>
  </View>;
}

function KeyedChild({name}) {
  const ref = useRef(null);
  const [value, setValue] = useState(name);
  useLayoutEffect(() => { result.ids[name] = ref.current.id; });
  return <Pressable ref={ref} testID={name} style={{height: 30}} onPress={() => setValue(`${name}!`)}>
    <Text style={{height: 20}}>{value}</Text>
  </Pressable>;
}
function Keyed() {
  const [reverse, setReverse] = useState(false);
  action = () => setReverse(value => !value);
  return <View style={{width: 200}}>{(reverse ? ['b', 'a'] : ['a', 'b']).map(name => <KeyedChild key={name} name={name} />)}</View>;
}

function Cleanup() {
  const ref = useRef(null);
  useLayoutEffect(() => { result.refID = ref.current.id; return () => { result.layoutCleanup++; }; }, []);
  useEffect(() => { result.effectSetup++; return () => { result.effectCleanup++; }; }, []);
  return <View ref={ref} testID="cleanup" style={{width: 30, height: 30}} />;
}

const suspended = new Promise(() => {});
function Gate({pending}) { if (pending) throw suspended; return null; }
function Interrupted() {
  const [label, setLabel] = useState('committed');
  action = () => startTransition(() => setLabel('uncommitted'));
  return <Suspense fallback={<Text>Loading</Text>}>
    <View style={{width: 200}}>
      <Pressable testID="handler" style={{height: 40}} onPress={() => result.handlers.push(label)}>
        <Text style={{height: 20}}>{label}</Text>
      </Pressable>
      <Gate pending={label === 'uncommitted'} />
    </View>
  </Suspense>;
}

function PropReset() {
  const [reset, setReset] = useState(false);
  action = () => setReset(true);
  return <View style={{width: 200, height: 100}}>
    <View testID="props" accessibilityLabel={reset ? undefined : 'old'} style={reset ? {height: 20} : {width: 50, height: 40, marginLeft: 10}} />
  </View>;
}

class Boundary extends React.Component {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch() { result.caught++; }
  render() {
    return this.state.failed ? <Text testID="fallback" style={{height: 30}}>Recovered</Text> : this.props.children;
  }
}
function ThrowingChild() { throw new Error('EXPECTED_BOUNDARY_FAILURE'); }

function CommandQueue({replace = false, web = false}) {
  const [step, setStep] = useState(0);
  const ref = useRef(null);
  useLayoutEffect(() => {
    result.ids.push(ref.current.id);
    if (web) ref.current.injectJavaScript(`window.commandStep=${step}`);
    else ref.current.focus();
    if (step === 0) setStep(1);
  }, [step]);
  return web ? <WebView ref={ref} testID="command-target" source={{html: `page ${step}`}} /> :
    <TextInput key={replace ? step : 'stable'} ref={ref} testID="command-target" defaultValue="value" />;
}

function ControlledText({reject = false, listener = true}) {
  const [value, setValue] = useState('seed');
  return <TextInput testID="controlled-text" value={value} mostRecentEventCount={999}
    onChangeText={listener ? text => { result.received.push(text); if (!reject) setValue(text); } : undefined} />;
}

export function loadScenario(name) {
  render(null);
  action = () => { throw new Error(`No action for ${name}`); };
  switch (name) {
    case 'atomic-layout': result = {effects: [], geometry: []}; render(<AtomicLayout />); break;
    case 'keyed': result = {ids: {}}; render(<Keyed />); break;
    case 'cleanup': result = {layoutCleanup: 0, effectSetup: 0, effectCleanup: 0}; render(<Cleanup />); break;
    case 'interrupted': result = {handlers: []}; render(<Interrupted />); break;
    case 'prop-reset': result = {}; render(<PropReset />); break;
    case 'error-boundary': result = {caught: 0}; render(<Boundary><ThrowingChild /></Boundary>); break;
    case 'submit-editing': result = {submitted: []}; render(<TextInput testID="submit-input" onSubmitEditing={event => result.submitted.push(event.nativeEvent.text)} />); break;
    case 'command-queue': result = {ids: []}; render(<CommandQueue />); break;
    case 'command-replace': result = {ids: []}; render(<CommandQueue replace />); break;
    case 'command-document-replace': result = {ids: []}; render(<CommandQueue web />); break;
    case 'controlled-text': result = {received: []}; render(<ControlledText />); break;
    case 'controlled-text-reject': result = {received: []}; render(<ControlledText reject />); break;
    case 'controlled-text-no-handler': result = {received: []}; render(<ControlledText listener={false} />); break;
    default: throw new Error(`Unknown scenario ${name}`);
  }
}
export const scenarioResult = () => result;
export const scenarioAction = () => { action(); return {scheduled: true}; };
