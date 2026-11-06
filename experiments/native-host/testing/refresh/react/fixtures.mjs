export function screenSource({label = 'initial', step = 1, extraHook = false,
  imports = 'import {suffix} from "./value.js";', suffix = 'suffix', mixed = false, children = ''} = {}) {
  return `import React, {useState, useRef, useEffect, useLayoutEffect} from 'react';
import {View,Text,TextInput,Pressable} from ${JSON.stringify(globalThis.__refreshFixtureRenderer)};
${imports}
export default function Screen() {
  const [count,setCount] = useState(0);
  const [text,setText] = useState('seed');
  ${extraHook ? 'const [added] = useState("new-hook");' : ''}
  const marker = useRef({identity:'marker'});
  const input = useRef(null);
  globalThis.__testMarker = marker.current;
  globalThis.__testScreenReact = React;
  useLayoutEffect(() => {globalThis.__testInputRef = input.current;});
  useEffect(() => {globalThis.__testEffects.push('setup:${label}'); return () => globalThis.__testEffects.push('cleanup:${label}');}, []);
  return <View testID="screen" style={{width:300,height:180}}>
    <Text testID="count">{count}</Text><Text testID="label">${label}:{${suffix}}</Text>
    <TextInput testID="input" ref={input} value={text} onChangeText={setText} style={{height:40}} />
    <Pressable testID="button" onPress={() => setCount(value => value + ${step})} style={{height:40}}><Text>Update</Text></Pressable>
    ${children}
  </View>;
}
${mixed ? 'export const metadata = "mixed";' : ''}
`;
}
