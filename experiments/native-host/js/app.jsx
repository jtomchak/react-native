import React, {useState} from 'react';
import {View, Text, Image, Pressable, TextInput, ScrollView, WebView} from './renderer.js';
import {echo} from './services.js';

const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui;margin:8px}button,input{padding:10px}button{display:block;width:100%;margin-top:6px}</style>
<input aria-label="Email" placeholder="Email"><button id="web-target" onclick="window.__tapCount++;this.textContent='Web action '+window.__tapCount;window.NativeHost.postMessage(JSON.stringify({type:'web-press',count:window.__tapCount}))">Web action</button>
<script>window.__tapCount=0</script>`;
const source = {html};
const pixel = {uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII='};
const button = {height: 42, width: '100%', backgroundColor: '#dce8ff', padding: 8};

export function Demo() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('Native');
  const [result, setResult] = useState('Echo ready');
  const [covered, setCovered] = useState(false);
  const [web, setWeb] = useState(0);
  const [secondary, setSecondary] = useState(0);
  const [overlay, setOverlay] = useState(0);
  return <ScrollView testID="scroll" style={{width: '100%', height: '100%'}}>
    <View testID="demo" style={{padding: 12, gap: 6, width: '100%', flexDirection: 'column'}}>
      <Text testID="heading" style={{height: 28, fontSize: 20}}>Native host prototype</Text>
      <Pressable testID="increment" accessibilityRole="button" accessibilityLabel="Increment" style={button} onPress={() => setCount(value => value + 1)}>
        <Text testID="count-label" style={{height: 24}}>Count: {count}</Text>
      </Pressable>
      <TextInput testID="name-input" accessibilityLabel="Name" value={name} onChangeText={setName} style={{height: 40, width: '100%', borderWidth: 1}} />
      <Pressable testID="echo-button" accessibilityRole="button" accessibilityLabel="Echo" style={button} onPress={() => {
        setResult('Echo pending');
        echo(name, 10).promise.then(value => setResult(`Echo: ${value}`), error => setResult(error.code));
      }}><Text style={{height: 24}}>Echo through Rust</Text></Pressable>
      <Text testID="service-result" style={{height: 24}}>{result}</Text>
      <Pressable testID="toggle-overlay" accessibilityRole="button" accessibilityLabel="Toggle cover" style={button} onPress={() => setCovered(value => !value)}>
        <Text style={{height: 24}}>{covered ? 'Uncover WebView' : 'Cover WebView'}</Text>
      </Pressable>
      <View testID="web-container" style={{height: 130, width: '100%'}}>
        <WebView testID="web-primary" source={source} style={{position: 'absolute', top: 0, left: 0, width: '100%', height: 130}} onMessage={() => setWeb(value => value + 1)} />
        {covered && <Pressable testID="web-overlay" accessibilityRole="button" accessibilityLabel="Web cover" style={{position: 'absolute', top: 0, left: 0, width: '100%', height: 130, backgroundColor: '#ffd5b5'}} onPress={() => setOverlay(value => value + 1)}>
          <Text style={{height: 24}}>Native cover</Text>
        </Pressable>}
      </View>
      <Text testID="web-result" style={{height: 22}}>Primary: {web}</Text>
      <Text testID="overlay-result" style={{height: 22}}>Overlay: {overlay}</Text>
      <WebView testID="web-secondary" source={source} style={{height: 130, width: '100%'}} onMessage={() => setSecondary(value => value + 1)} />
      <Text testID="web-secondary-result" style={{height: 22}}>Secondary: {secondary}</Text>
      <Image testID="image" source={pixel} accessibilityLabel="Sample image" style={{width: 24, height: 24}} />
    </View>
  </ScrollView>;
}
