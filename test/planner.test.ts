import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanInput, planRelics } from '../src/lib/planner';
import { SLOTS, rollsCap } from '../src/lib/relicdata';
import { exactOptimum } from './planner-oracle';

// 플래너가 예전에 전역 최적해를 놓쳤던 시나리오들(두 부위를 함께 바꿔야 개선되는 경우)
const HARD: PlanInput[] = [
  { name: 'sc57', base: { hp: 1369, atk: 638, def: 766, spd: 102 }, main: { body: 'crit_rate', feet: 'atk_pct', sphere: 'hp_pct', rope: 'energy_regen' }, weights: { hp: 1.7, def: 0.3, hp_pct: 0.6, def_pct: 0.3, spd: 2.2, crit_rate: 1, effect_hit: 1, effect_res: 2.4, break_effect: 1.8 }, targets: [{ stat: 'crit_dmg', min: 79.2 }], start: { head: 4, hands: 4, body: 4, feet: 3, sphere: 3, rope: 4 }, seed: 1057, effort: 3 },
  { name: 'sc6', base: { hp: 1399, atk: 694, def: 767, spd: 99 }, main: { body: 'effect_hit', feet: 'spd', sphere: 'atk_pct', rope: 'hp_pct' }, weights: { atk: 0.5, def: 2.3, hp_pct: 2.7, spd: 1.7, effect_res: 1.7, break_effect: 1.2 }, targets: [{ stat: 'crit_rate', min: 13.7 }, { stat: 'crit_dmg', min: 131.6 }, { stat: 'break_effect', min: 17.5 }], start: { head: 4, hands: 3, body: 3, feet: 4, sphere: 3, rope: 4 }, seed: 1006, effort: 3 },
  { name: 'sc10', base: { hp: 1375, atk: 730, def: 724, spd: 101 }, main: { body: 'hp_pct', feet: 'hp_pct', sphere: 'def_pct', rope: 'energy_regen' }, weights: { hp: 3, atk: 2.3, def: 1.6, hp_pct: 2.9, crit_dmg: 1.8, break_effect: 0.2 }, targets: [{ stat: 'spd', min: 117.1 }, { stat: 'crit_rate', min: 40 }, { stat: 'break_effect', min: 46.7 }], start: { head: 4, hands: 4, body: 3, feet: 3, sphere: 4, rope: 4 }, seed: 1010, effort: 3 },
  { name: 'sc52', base: { hp: 1081, atk: 710, def: 721, spd: 97 }, main: { body: 'hp_pct', feet: 'hp_pct', sphere: 'elemental_dmg', rope: 'energy_regen' }, weights: { hp_pct: 2.7, atk_pct: 1.4, def_pct: 1.6, spd: 2.3 }, targets: [{ stat: 'crit_dmg', min: 131.6 }, { stat: 'effect_res', min: 7.8 }], start: { head: 3, hands: 4, body: 3, feet: 3, sphere: 3, rope: 4 }, seed: 1052, effort: 3 },
];

for (const sc of HARD) {
  test(`플래너: 정확한 동적계획 최적해와 일치한다 (${sc.name})`, () => {
    const ex = exactOptimum(sc);
    const pl = planRelics(sc);
    assert.equal(pl.feasible, ex.feasible);
    assert.ok(ex.feasible, '시험 시나리오는 실현 가능해야 한다');
    assert.ok(Math.abs(pl.objective_value - ex.value) < 1e-3, `planner ${pl.objective_value} vs exact ${ex.value}`);
  });
}

test('플래너: 부품 제약(롤 합계·4종·최대 롤·주옵션 중복 금지)을 항상 지킨다', () => {
  const sc = HARD[1];
  const pl = planRelics(sc);
  for (const slot of SLOTS) {
    const ps = pl.slots.find((s) => s.slot === slot)!;
    const start = ps.start;
    assert.equal(ps.rolls_total, rollsCap(start), `${slot} 롤 합계`);
    assert.equal(ps.subs.length, 4, `${slot} 부옵션은 4종`);
    for (const s of ps.subs) {
      assert.ok(s.rolls >= 1 && s.rolls <= (start === 4 ? 6 : 5), `${slot} ${s.key} 롤 ${s.rolls}`);
      assert.notEqual(s.key, ps.main, `${slot} 주옵션과 같은 부옵션`);
    }
  }
  assert.deepEqual(pl.calc.warnings, []);
});

test('플래너: 도달 불가능한 목표는 feasible=false와 shortfalls(최대 도달치)로 알린다', () => {
  const pl = planRelics({ base: { hp: 1300, atk: 600, def: 700, spd: 100 }, main: { body: 'crit_rate', feet: 'atk_pct', sphere: 'atk_pct', rope: 'atk_pct' }, weights: { spd: 1 }, targets: [{ stat: 'spd', min: 200 }] });
  assert.equal(pl.feasible, false);
  assert.equal(pl.shortfalls[0].stat, 'spd');
  assert.ok(pl.shortfalls[0].max_possible < 200);
  assert.ok(pl.notes.some((n) => n.includes('찾지 못했습니다')));
});

test('플래너: forbid로 지정한 부옵션은 그 부위에 붙지 않는다', () => {
  const pl = planRelics({ base: { hp: 1300, atk: 600, def: 700, spd: 100 }, main: { body: 'crit_rate', feet: 'spd', sphere: 'atk_pct', rope: 'atk_pct' }, weights: { crit_dmg: 3, atk_pct: 2 }, forbid: { head: ['crit_dmg'], hands: ['crit_dmg'] }, targets: [] });
  for (const slot of ['head', 'hands'] as const) assert.ok(!pl.slots.find((s) => s.slot === slot)!.subs.some((s) => s.key === 'crit_dmg'));
  assert.ok(pl.slots.find((s) => s.slot === 'body')!.subs.some((s) => s.key === 'crit_dmg'));
});

test('플래너: 같은 입력·시드면 결과가 같다(재현성)', () => {
  const sc = { ...HARD[3], effort: 1 };
  const a = planRelics(sc);
  const b = planRelics(sc);
  assert.deepEqual(a.slots, b.slots);
  assert.equal(a.objective_value, b.objective_value);
});

test('플래너: 상한(max)도 지킨다 — 하한~상한 창 안에 들어온다', () => {
  const base = { hp: 1300, atk: 600, def: 700, spd: 100 };
  const pl = planRelics({ base, main: { body: 'crit_rate', feet: 'spd', sphere: 'atk_pct', rope: 'atk_pct' }, objective: { type: 'dps', stat: 'atk' }, targets: [{ stat: 'spd', min: 140, max: 145 }] });
  assert.equal(pl.feasible, true);
  assert.deepEqual(pl.overshoots, []);
  const spd = pl.calc.final.spd;
  assert.ok(spd >= 140 && spd <= 145, `속도 ${spd}`);
});

test('플래너: 주옵션만으로 이미 상한을 넘으면 shortfalls가 아니라 overshoots로 알린다', () => {
  // 발 속도 주옵션(+25.032)만으로 100 + 25.032 = 125.03 > 상한 120
  const pl = planRelics({ base: { hp: 1300, atk: 600, def: 700, spd: 100 }, main: { body: 'crit_rate', feet: 'spd', sphere: 'atk_pct', rope: 'atk_pct' }, objective: { type: 'dps', stat: 'atk' }, targets: [{ stat: 'spd', min: 110, max: 120 }] });
  assert.equal(pl.feasible, false);
  assert.deepEqual(pl.shortfalls, []);
  assert.equal(pl.overshoots.length, 1);
  assert.equal(pl.overshoots[0].stat, 'spd');
  assert.ok(pl.overshoots[0].min_possible > 120, `min_possible ${pl.overshoots[0].min_possible}`);
  assert.ok(pl.notes.some((n) => n.includes('상한을 넘었습니다')));
  assert.equal(pl.calc.target_checks[0].status, 'above_max');
  assert.ok(pl.calc.markdown.includes('상한 초과'));
  // 이 경우 속도 롤은 하나도 얹지 않는다
  assert.ok(!pl.slots.some((s) => s.subs.some((x) => x.key === 'spd')));
});

test('플래너: 하한이 상한보다 크면 오류', () => {
  assert.throws(() => planRelics({ base: { hp: 1300, atk: 600, def: 700, spd: 100 }, main: { body: 'crit_rate', feet: 'spd', sphere: 'atk_pct', rope: 'atk_pct' }, targets: [{ stat: 'spd', min: 150, max: 140 }] }), /min\(150\)이 max\(140\)보다 큽니다/);
});
