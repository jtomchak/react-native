import PerformanceExample from './PerformanceExample';
export const title = 'Native Host Performance';
export const description = 'Shared fixed-geometry primitive workload; full RNTester graph retained.';
export const examples = [{
  name: 'shared-workload',
  title: 'Shared primitive workload',
  // The workload owns its ScrollView; don't add an outer scrolling container.
  scrollable: false,
  render: PerformanceExample,
}];
