import test from 'node:test';
import assert from 'node:assert/strict';
import {compareContracts} from '../../scripts/compare-contracts.mjs';

function sample() {
  return {schemaVersion: 1, runtime: {renderer: 'test'}, cases: [
    {id: 'layout-effect-cascade', observations: {effects: [0, 1], widths: [60, 120], finalWidth: 120, cleanup: 1}},
    {id: 'keyed-state-and-host-ref', observations: {
      stages: ['mounted', 'updated', 'reordered'].map(phase => ({phase, nodes: ['a', 'b'].map(name => ({name, value: 0, sameHostRef: true, y: 0, width: 40}))})),
      effects: ['a:0', 'b:0'], cleanup: ['b', 'a'],
    }},
  ]};
}
test('matches complete observations even when runtime identities differ', () => {
  const other = sample(); other.runtime.renderer = 'different';
  assert.equal(compareContracts(sample(), other).passed, true);
});
for (const [name, mutate] of [
  ['empty cases', x => { x.cases = []; }],
  ['missing case', x => { x.cases.pop(); }],
  ['extra case', x => { x.cases.push({id: 'extra', observations: {a: 1}}); }],
  ['duplicate case', x => { x.cases[1] = x.cases[0]; }],
  ['empty observations', x => { x.cases[0].observations = {}; }],
  ['missing field', x => { delete x.cases[0].observations.cleanup; }],
  ['extra field', x => { x.cases[0].observations.extra = true; }],
  ['width mismatch', x => { x.cases[0].observations.widths[1] = 121; }],
  ['effect order mismatch', x => { x.cases[0].observations.effects.reverse(); }],
  ['lost host identity', x => { x.cases[1].observations.stages[2].nodes[0].sameHostRef = false; }],
]) {
  test(`rejects ${name}`, () => { const other = sample(); mutate(other); assert.throws(() => compareContracts(sample(), other)); });
}
test('rejects equally malformed observations on both sides', () => {
  const value = sample(); value.cases[1].observations.stages = [];
  assert.throws(() => compareContracts(value, value));
});
