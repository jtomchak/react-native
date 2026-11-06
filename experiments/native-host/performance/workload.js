// Copy this file byte-for-byte into RNTester. Only the injected renderer differs.
export const WORKLOAD_VERSION = 1;
export const ROW_COUNT = 100;
const image = {uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGNQy7z1nxLMMGrAqAGjBgwXAwAPTmgfod+4cgAAAABJRU5ErkJggg=='};

export function createPerformanceScreen(React, {View, Text, Image, Pressable, TextInput, ScrollView}) {
  const h = React.createElement;
  return function PerformanceScreen({revision}) {
    const [count, setCount] = React.useState(0);
    const [input, setInput] = React.useState('seed');
    const [reverse, setReverse] = React.useState(false);
    const [mounted, setMounted] = React.useState(true);
    const rows = Array.from({length: ROW_COUNT}, (_, index) => index);
    if (reverse) rows.reverse();
    const button = (id, label, onPress) => h(Pressable, {
      key: id, testID: id, accessibilityLabel: label, accessibilityRole: 'button', onPress,
      style: {width: 94, height: 40, padding: 5, backgroundColor: '#dce8ff'},
    }, h(Text, {style: {height: 28, fontSize: 14}}, label));
    return h(View, {testID: 'perf-root', collapsable: false,
      style: {width: 320, height: 540, padding: 8, gap: 6, backgroundColor: '#ffffff'}},
    h(Text, {testID: 'perf-revision', accessibilityLabel: `Revision: ${revision}`,
      style: {height: 28, fontSize: 14}}, `Revision: ${revision}`),
    h(Text, {testID: 'perf-state', style: {height: 24, fontSize: 14}}, `Count: ${count}; order: ${reverse ? 'reverse' : 'forward'}`),
    h(Image, {testID: 'perf-image', source: image, resizeMode: 'contain', style: {width: 16, height: 16}}),
    h(TextInput, {testID: 'perf-input', accessibilityLabel: 'Performance input', value: input,
      onChangeText: setInput, style: {height: 40, width: 300, borderWidth: 1, padding: 4}}),
    h(Text, {testID: 'perf-input-value', style: {height: 24, fontSize: 14}}, `Input: ${input}`),
    h(View, {style: {flexDirection: 'row', gap: 6, height: 40}},
      button('perf-update', 'Update', () => setCount(value => value + 1)),
      button('perf-reorder', 'Reorder', () => setReverse(value => !value)),
      button('perf-toggle', mounted ? 'Unmount' : 'Mount', () => setMounted(value => !value))),
    h(Text, {testID: 'perf-mounted', style: {height: 24, fontSize: 14}}, `Rows: ${mounted ? ROW_COUNT : 0}`),
    mounted ? h(ScrollView, {testID: 'perf-scroll', style: {height: 270, width: 300}},
      h(View, {style: {width: 300, height: ROW_COUNT * 32}}, rows.map(index =>
        h(View, {key: index, testID: `perf-row-${index}`, collapsable: false,
          style: {height: 32, width: 300, backgroundColor: index % 2 ? '#f1f3f5' : '#ffffff'}},
        h(Text, {style: {height: 32, fontSize: 14}}, `Row ${index}: ${count}`))))) : null);
  };
}
