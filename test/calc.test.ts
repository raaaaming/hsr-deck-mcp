import test from 'node:test';
import assert from 'node:assert/strict';
import { calcBuild, evalScale } from '../src/lib/calc';

const close = (a: number, b: number, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} ≠ ${b}`);

const RELICS = {
  head: { main: 'hp', subs: { spd: 3 } },
  hands: { main: 'atk', subs: { atk_pct: 2 } },
  body: { main: 'crit_rate', subs: {} },
  feet: { main: 'spd', subs: {} },
  sphere: { main: 'atk_pct', subs: {} },
  rope: { main: 'energy_regen', subs: {} },
} as const;

test('스탯 합산: HP/공격/방어는 (캐릭터+광추 기초)×(1+Σ%)+Σ고정, 속도는 캐릭터 기초만 곱해진다', () => {
  const r = calcBuild({
    base: { hp: 1000, atk: 500, def: 600, spd: 100 },
    light_cone: { hp: 400, atk: 200, def: 100 },
    modifiers: [
      { stat: 'atk', value: 10, unit: 'pct', group: 'minor_traces' },
      { stat: 'spd', value: 9, unit: 'flat', group: 'minor_traces' },
      { stat: 'crit_rate', value: 6.7, group: 'minor_traces' },
    ],
    relics: RELICS as any,
  });
  close(r.final.hp, 1400 + 705.6, 1e-3, 'hp');
  // 부옵션 공격력% 평균 롤 = 3.4560002 + 0.43200003, 2회
  close(r.final.atk, 700 * (1 + (10 + 43.2 + 2 * (3.4560002 + 0.43200003)) / 100) + 352.8, 1e-2, 'atk');
  close(r.final.def, 700, 1e-6, 'def');
  close(r.final.spd, 100 + 9 + 25.032 + 3 * 2.3, 1e-6, 'spd');
  close(r.final.crit_rate, 5 + 6.7 + 32.4, 1e-6, 'crit rate');
  close(r.final.crit_dmg, 50, 1e-6, 'crit dmg');
  close(r.final.energy_regen, 100 + 19.439, 1e-6, 'ER');
  assert.deepEqual(r.warnings, []);
});

test('스탯 합산: 출처별 기여 표(그룹)와 광추 기본 열이 나온다', () => {
  const r = calcBuild({
    base: { hp: 1000, atk: 500, def: 600, spd: 100 },
    light_cone: { hp: 400, atk: 200, def: 100 },
    modifiers: [{ stat: 'def', value: 22.5, unit: 'pct', group: 'minor_traces' }],
    relics: RELICS as any,
  });
  const def = r.rows.find((x) => x.stat === 'def')!;
  close(def.base, 600);
  close(def.lc_base, 100);
  close(def.groups.minor_traces, 700 * 0.225, 1e-6);
  close(def.final, 700 * 1.225, 1e-6);
  assert.ok(r.groups_used.includes('minor_traces'));
  assert.ok(r.markdown.includes('광추 기본'));
  assert.ok(r.markdown.includes('| 부위 | 주옵션 |'));
});

test('스탯 합산: 다른 스탯에 비례하는 보너스(scale)를 계산한다 (임계값·구간·상한)', () => {
  assert.equal(evalScale({ from: 'def', threshold: 1000, step: 100, per: 5 }, { def: 1500 }), 25);
  assert.equal(evalScale({ from: 'def', threshold: 1000, step: 100, per: 5 }, { def: 999 }), 0);
  assert.equal(evalScale({ from: 'def', threshold: 1000, step: 100, per: 5, cap_over: 300 }, { def: 1900 }), 15);
  assert.equal(evalScale({ from: 'spd', threshold: 120, base: 10, step: 10, per: 2 }, { spd: 143 }), 14);
  assert.equal(evalScale({ from: 'spd', threshold: 120, step: 10, per: 2, floor: false }, { spd: 135 }), 3);
  const r = calcBuild({
    base: { hp: 1000, atk: 500, def: 600, spd: 100 },
    modifiers: [
      { stat: 'def', value: 100, unit: 'pct', group: 'minor_traces' },
      { stat: 'atk', unit: 'pct', group: 'major_traces', scale: { from: 'def', threshold: 1000, step: 100, per: 5 } },
    ],
  });
  close(r.final.def, 1200);
  close(r.final.atk, 500 * 1.1, 1e-6); // DEF 1200 → 초과 200 → +10%
  assert.equal(r.resolved_scales[0].from, 'def');
});

test('스탯 합산: 서로를 참조하는 scale도 고정점으로 수렴한다', () => {
  const r = calcBuild({
    base: { hp: 1000, atk: 1000, def: 1000, spd: 100 },
    modifiers: [
      { stat: 'atk', unit: 'pct', scale: { from: 'def', threshold: 1000, step: 100, per: 1 } },
      { stat: 'def', unit: 'pct', scale: { from: 'atk', threshold: 1000, step: 100, per: 1 } },
      { stat: 'def', value: 20, unit: 'pct' },
    ],
  });
  // def = 1000×(1+0.20+Δ) → atk 증가 = floor((def-1000)/100)% … 고정점에서 두 식이 모두 성립해야 한다
  const atkPct = Math.floor((r.final.def - 1000) / 100 + 1e-9);
  const defPct = 20 + Math.floor((r.final.atk - 1000) / 100 + 1e-9);
  close(r.final.atk, 1000 * (1 + atkPct / 100), 1e-4);
  close(r.final.def, 1000 * (1 + defPct / 100), 1e-4);
  assert.ok(!r.warnings.some((w) => w.includes('수렴')));
});

test('스탯 합산: 서로를 키우며 발산하는 scale은 경고한다', () => {
  const r = calcBuild({
    base: { hp: 1000, atk: 1000, def: 1000, spd: 100 },
    modifiers: [
      { stat: 'atk', unit: 'pct', scale: { from: 'def', threshold: 1000, step: 100, per: 10 } },
      { stat: 'def', unit: 'pct', scale: { from: 'atk', threshold: 1000, step: 100, per: 10 } },
      { stat: 'def', value: 20, unit: 'pct' },
    ],
  });
  assert.ok(r.warnings.some((w) => w.includes('수렴하지 않았습니다')), r.warnings.join('|'));
});

test('목표 판정: 하한/상한과 여유(margin)', () => {
  const r = calcBuild({
    base: { hp: 1000, atk: 500, def: 600, spd: 100 },
    modifiers: [{ stat: 'spd', value: 34, unit: 'flat' }],
    targets: [
      { stat: 'spd', min: 134, label: '속도 134' },
      { stat: 'spd', min: 135 },
      { stat: 'crit_rate', max: 5 },
      { stat: 'crit_rate', max: 4 },
    ],
  });
  assert.deepEqual(r.target_checks.map((t) => t.ok), [true, false, true, false]);
  close(r.target_checks[0].margin, 0);
  close(r.target_checks[1].margin, -1);
  assert.ok(r.markdown.includes('충족') && r.markdown.includes('미달'));
});

test('유물 검증: 같은 종류 부옵션·4종 초과·롤 한도 초과·부위 불가 주옵션은 경고', () => {
  const r = calcBuild({
    base: { hp: 1000, atk: 500, def: 600, spd: 100 },
    relics: {
      head: { main: 'hp', subs: { hp: 1 } }, // 주옵션과 같은 부옵션
      hands: { main: 'atk', subs: { spd: 1, crit_rate: 1, crit_dmg: 1, effect_hit: 1, effect_res: 1 } }, // 5종
      body: { main: 'crit_rate', subs: { spd: 6, crit_dmg: 4 } }, // 롤 10 > 9
      feet: { main: 'crit_dmg' as any, subs: {} }, // 발에 불가
      sphere: { main: 'atk_pct', subs: { spd: 7 } }, // 한 부옵션 7회
      rope: { main: 'energy_regen', subs: {}, start: 3 },
    } as any,
  });
  const w = r.warnings.join('|');
  assert.ok(w.includes('주옵션과 같은 부옵션'), w);
  assert.ok(w.includes('최대 4종'), w);
  assert.ok(w.includes('한도'), w);
  assert.ok(w.includes('선택할 수 없습니다'), w);
  assert.ok(w.includes('최대 6회'), w);
});

test('유물 품질: 부옵션 롤 값은 하/중/상 = base, base+step, base+2·step', () => {
  const mk = (q: 'low' | 'avg' | 'high') =>
    calcBuild({ base: { hp: 1, atk: 1, def: 1, spd: 100 }, quality: q, relics: { feet: { main: 'spd', subs: { crit_dmg: 1 } } } as any }).final.crit_dmg;
  close(mk('low'), 50 + 5.184, 1e-9);
  close(mk('avg'), 50 + 5.832, 1e-9);
  close(mk('high'), 50 + 6.48, 1e-9);
});

test('modifier 입력 실수: 값이 없는 항목, 부옵션 키(atk_pct)를 스탯 키로 쓴 항목은 경고한다', () => {
  const r = calcBuild({
    base: { hp: 1, atk: 100, def: 1, spd: 100 },
    modifiers: [
      { stat: 'atk', label: '값 누락' },
      { stat: 'atk_pct', value: 18 },
      { stat: 'atk', value: 10, unit: 'pct', group: 'minor_traces' },
    ],
  });
  const w = r.warnings.join('|');
  assert.ok(w.includes('값 누락') && w.includes('반영되지 않았습니다'), w);
  assert.ok(w.includes('atk_pct') && w.includes('부옵션 키'), w);
  close(r.final.atk, 110, 1e-9, '정상 항목만 반영');
});
