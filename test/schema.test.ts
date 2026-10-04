import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/lib/tools';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const BASE = { hp: 1000, atk: 600, def: 400, spd: 100 };

test('툴 입력 스키마: 잘못된 부위 키(boots)는 조용히 버려지지 않고 오류가 된다', () => {
  const calc = tool('hsr_calc_build').input;
  const ok = calc.safeParse({ base: BASE, relics: { feet: { main: 'spd', subs: { crit_rate: 3 } } } });
  assert.ok(ok.success);
  const bad = calc.safeParse({ base: BASE, relics: { boots: { main: 'spd' } } });
  assert.ok(!bad.success);
  assert.ok(JSON.stringify(bad.error.issues).includes('boots'));

  const plan = tool('hsr_plan_relics').input;
  assert.ok(!plan.safeParse({ base: BASE, main: { boots: 'spd' } }).success);
  assert.ok(plan.safeParse({ base: BASE, main: { feet: 'spd', body: 'crit_rate' }, start: { head: 3 } }).success);
  assert.ok(!plan.safeParse({ base: BASE, main: { feet: 'spd' }, start: { boots: 3 } }).success);
});

test('툴 입력 스키마: modifier·target·relic piece의 오타 필드도 오류가 된다', () => {
  const calc = tool('hsr_calc_build').input;
  assert.ok(calc.safeParse({ base: BASE, modifiers: [{ stat: 'atk', value: 10, unit: 'pct' }] }).success);
  assert.ok(!calc.safeParse({ base: BASE, modifiers: [{ stat: 'atk', val: 10 }] }).success);
  assert.ok(!calc.safeParse({ base: BASE, modifiers: [{ stat: 'atk', value: 10, scale: { from: 'def', pr: 1 } }] }).success);
  assert.ok(!calc.safeParse({ base: BASE, targets: [{ stat: 'spd', minimum: 120 }] }).success);
  assert.ok(!calc.safeParse({ base: BASE, relics: { head: { main: 'hp', substats: { spd: 1 } } } }).success);
});

test('툴 입력 스키마: hsr_prepare_party의 calc_seed(base/light_cone/modifiers)를 그대로 hsr_calc_build에 넣을 수 있다', () => {
  const seed = {
    base: { hp: 931.39, atk: 640.33, def: 363.83, spd: 115, crit_rate: 5, crit_dmg: 50, energy_regen: 100 },
    light_cone: { hp: 952.6, atk: 476.3, def: 396.4 },
    modifiers: [
      { stat: 'atk', value: 28, unit: 'pct' as const, group: 'minor_traces', label: '작은 행적 합계(10개 전부 활성)' },
      { stat: 'crit_rate', value: 12, unit: 'pct' as const, group: 'minor_traces', label: '작은 행적 합계(10개 전부 활성)' },
    ],
  };
  assert.ok(tool('hsr_calc_build').input.safeParse(seed).success);
  assert.ok(tool('hsr_plan_relics').input.safeParse({ ...seed, main: { feet: 'spd' } }).success);
});

test('툴 입력 스키마: 시뮬레이터 입력 검증', () => {
  const sim = tool('hsr_simulate_turns').input;
  assert.ok(sim.safeParse({ units: [{ name: 'A', spd: 134 }], events: [{ after: { actor: 'A', nth: 1 }, target: 'A', kind: 'advance', value: 24 }], max_av: 350 }).success);
  assert.ok(!sim.safeParse({ units: [] }).success);
  assert.ok(!sim.safeParse({ units: [{ name: 'A', spd: 134 }], events: [{ after: { actor: 'A' }, target: 'A', kind: 'teleport', value: 1 }] }).success);
});
