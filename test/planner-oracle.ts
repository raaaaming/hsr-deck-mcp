// 테스트용 정확해(오라클): 목표가 "한 부옵션 종류로만 오르는 스탯"(속도·치확·치피·효명·효저·격파)이고 목적이 weights일 때,
// 부위별 선택지를 (목표 롤 수 튜플 → 최대 가치)로 압축한 뒤 부위 6개를 동적계획으로 합쳐 전역 최적값을 구한다.
import { calcBuild } from '../src/lib/calc';
import type { PlanInput } from '../src/lib/planner';
import { TIE_WEIGHTS } from '../src/lib/planner';
import { SLOTS, SUB_KEYS, Slot, SubKey, rollsCap, subRollValue } from '../src/lib/relicdata';

export const SIMPLE_STATS: Record<string, SubKey> = {
  spd: 'spd',
  crit_rate: 'crit_rate',
  crit_dmg: 'crit_dmg',
  effect_hit: 'effect_hit',
  effect_res: 'effect_res',
  break_effect: 'break_effect',
};

function compositions(total: number, parts: number, lo: number, hi: number): number[][] {
  const out: number[][] = [];
  const rec = (i: number, left: number, cur: number[]) => {
    if (i === parts - 1) {
      if (left >= lo && left <= hi) out.push([...cur, left]);
      return;
    }
    for (let v = lo; v <= hi && v <= left - lo * (parts - 1 - i); v++) rec(i + 1, left - v, [...cur, v]);
  };
  rec(0, total, []);
  return out;
}

function subsets(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (s: number, cur: number[]) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = s; i < n; i++) rec(i + 1, [...cur, i]);
  };
  rec(0, []);
  return out;
}

export function exactOptimum(input: PlanInput): { feasible: boolean; value: number } {
  const quality = input.quality ?? 'avg';
  const main: Record<string, string> = {};
  for (const s of SLOTS) main[s] = input.main[s] ?? (s === 'head' ? 'hp' : s === 'hands' ? 'atk' : '');
  const startOf = (s: Slot): 3 | 4 => {
    const st = input.start;
    return st === 3 || st === 4 ? st : (st && st[s]) || 4;
  };
  const mainOnly: any = {};
  for (const s of SLOTS) mainOnly[s] = { main: main[s], subs: {}, start: startOf(s), quality };
  const cur = calcBuild({ name: input.name, base: input.base, light_cone: input.light_cone, base_extra: input.base_extra, modifiers: input.modifiers, relics: mainOnly, quality }).final;
  const targets = (input.targets ?? []).filter((t) => t.min != null);
  for (const t of targets) if (!SIMPLE_STATS[t.stat]) throw new Error('오라클이 지원하지 않는 목표: ' + t.stat);
  const need = targets.map((t) => {
    const x = (t.min! - (cur[t.stat] ?? 0)) / subRollValue(SIMPLE_STATS[t.stat], quality);
    return x <= 1e-9 ? 0 : Math.ceil(x - 1e-9);
  });
  const tIdx = targets.map((t) => SUB_KEYS.indexOf(SIMPLE_STATS[t.stat]));
  const w = SUB_KEYS.map((k) => (input.weights?.[k] ?? 0) + (TIE_WEIGHTS[k] ?? 0));

  const perSlot: Map<string, number>[] = [];
  for (const s of SLOTS) {
    const allowed = SUB_KEYS.map((_, i) => i).filter((i) => SUB_KEYS[i] !== (main[s] as string) && !(input.forbid?.[s] ?? []).includes(SUB_KEYS[i]));
    const comps = compositions(rollsCap(startOf(s)), 4, 1, 6);
    const best = new Map<string, number>();
    for (const sub of subsets(allowed.length, 4)) {
      const idx = sub.map((j) => allowed[j]);
      for (const c of comps) {
        let val = 0;
        const tup = tIdx.map(() => 0);
        for (let q = 0; q < 4; q++) {
          val += w[idx[q]] * c[q];
          const ti = tIdx.indexOf(idx[q]);
          if (ti >= 0) tup[ti] += c[q];
        }
        const key = tup.map((v, i) => Math.min(v, need[i])).join(',');
        if (val > (best.get(key) ?? -1e18)) best.set(key, val);
      }
    }
    perSlot.push(best);
  }
  let dp = new Map<string, number>([[need.map(() => 0).join(','), 0]]);
  for (const best of perSlot) {
    const nd = new Map<string, number>();
    for (const [k1, v1] of dp) {
      const a = k1 === '' ? [] : k1.split(',').map(Number);
      for (const [k2, v2] of best) {
        const b = k2 === '' ? [] : k2.split(',').map(Number);
        const key = a.map((x, i) => Math.min(x + b[i], need[i])).join(',');
        if (v1 + v2 > (nd.get(key) ?? -1e18)) nd.set(key, v1 + v2);
      }
    }
    dp = nd;
  }
  const v = dp.get(need.join(','));
  return v == null ? { feasible: false, value: NaN } : { feasible: true, value: v };
}
