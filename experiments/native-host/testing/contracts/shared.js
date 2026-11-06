// This exact module runs in both hosts. React and primitives are injected so
// each renderer uses its own matching React package and native View binding.
export function runContracts(React, {View}, {render, task}) {
  const {createElement: h, useLayoutEffect, useRef, useState} = React;
  const cases = [];
  const effects = [];
  const widths = [];
  let atomicRef;
  let atomicCleanup = 0;
  function Atomic() {
    const [value, setValue] = useState(0);
    const ref = useRef(null);
    useLayoutEffect(() => {
      effects.push(value);
      widths.push(ref.current.getBoundingClientRect().width);
      atomicRef = ref.current;
      if (value === 0) setValue(1);
    }, [value]);
    useLayoutEffect(() => () => { atomicCleanup++; }, []);
    return h(View, {ref, collapsable: false, style: {width: value ? 120 : 60, height: 40}});
  }
  task(() => render(h(Atomic)));
  const finalWidth = atomicRef.getBoundingClientRect().width;
  task(() => render(null));
  cases.push({id: 'layout-effect-cascade', observations: {effects, widths, finalWidth, cleanup: atomicCleanup}});

  const refs = {};
  const firstRefs = {};
  const values = {};
  const setters = {};
  const keyedEffects = [];
  const cleanup = [];
  let reverse;
  function Child({name}) {
    const [value, setValue] = useState(0);
    const ref = useRef(null);
    setters[name] = setValue;
    useLayoutEffect(() => {
      refs[name] = ref.current;
      firstRefs[name] ||= ref.current;
      values[name] = value;
      keyedEffects.push(`${name}:${value}`);
    });
    useLayoutEffect(() => () => { cleanup.push(name); }, []);
    return h(View, {ref, collapsable: false, style: {width: 40 + value * 20, height: 20}});
  }
  function Keyed() {
    const [flipped, setFlipped] = useState(false);
    reverse = () => setFlipped(true);
    return h(View, {collapsable: false, style: {width: 200, flexDirection: 'column'}},
      (flipped ? ['b', 'a'] : ['a', 'b']).map(name => h(Child, {key: name, name})));
  }
  function observe(phase) {
    return {phase, nodes: ['a', 'b'].map(name => {
      const rect = refs[name].getBoundingClientRect();
      return {name, value: values[name], sameHostRef: refs[name] === firstRefs[name], y: rect.y, width: rect.width};
    })};
  }
  task(() => render(h(Keyed)));
  const stages = [observe('mounted')];
  task(() => setters.a(1));
  stages.push(observe('updated'));
  task(reverse);
  stages.push(observe('reordered'));
  task(() => render(null));
  cases.push({id: 'keyed-state-and-host-ref', observations: {stages, effects: keyedEffects, cleanup}});
  return cases;
}
