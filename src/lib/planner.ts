// 유물 부옵션 롤 배분 플래너.
//  - 부위 6개 × 부옵션(최대 4종, 부품당 총 9롤/8롤, 같은 옵션 최대 6롤, 주옵션과 중복 불가)
//  - targets(최종 스탯 하한)을 반드시 만족하는 조합 중 weights(또는 DPS 기대값)를 최대화
//  - 담금질(simulated annealing) + 최속강하 마무리, 결정적 난수로 재현 가능
//  - 마지막에 calcBuild로 전체 계산을 다시 해서 2차 효과(scale 보너스 등)까지 검증하고 필요하면 재계획

import { BuildInput, CalcResult, Modifier, RelicPieceInput, Target, calcBuild, relicToModifiers, resolveModifiers } from './calc';
import {
  MAIN_OPTIONS,
  Quality,
  SLOTS,
  SLOT_KO,
  SUB_KEYS,
  SUB_KO,
  SUB_ROLL,
  Slot,
  SubKey,
  rollsCap,
  subRollValue,
} from './relicdata';
import { STAT_KO } from './stats';
import { mulberry32, r2 } from './util';

export interface PlanInput {
  name?: string;
  base: BuildInput['base'];
  light_cone?: BuildInput['light_cone'];
  base_extra?: Record<string, number>;
  /** 유물 부옵션 외의 모든 보너스(작은/큰 행적, 광추, 세트, 파티 버프 …) */
  modifiers?: Modifier[];
  /** 부위별 주옵션. head/hands는 생략하면 hp/atk */
  main: Partial<Record<Slot, string>>;
  start?: 3 | 4 | Partial<Record<Slot, 3 | 4>>;
  quality?: Quality;
  targets?: Target[];
  /** 부옵션 1회(평균) 롤의 상대 가치 */
  weights?: Partial<Record<SubKey, number>>;
  objective?: { type: 'weights' } | { type: 'dps'; stat?: 'atk' | 'hp' | 'def' };
  forbid?: Partial<Record<Slot, SubKey[]>>;
  seed?: number;
  effort?: number;
}

export interface PlanSlot {
  slot: Slot;
  slot_ko: string;
  main: string;
  start: 3 | 4;
  rolls_total: number;
  subs: { key: SubKey; ko: string; rolls: number }[];
}

export interface PlanResult {
  feasible: boolean;
  slots: PlanSlot[];
  totals: { key: SubKey; ko: string; rolls: number }[];
  relics: Partial<Record<Slot, RelicPieceInput>>;
  calc: CalcResult;
  objective_value: number;
  /** 하한 미달 목표(need=하한, max_possible=부옵션을 몰아줘도 닿는 최대치) */
  shortfalls: { stat: string; need: number; max_possible: number; actual: number }[];
  /** 상한 초과 목표(min_possible=부옵션 0롤일 때의 값) */
  overshoots: { stat: string; max: number; actual: number; min_possible: number }[];
  notes: string[];
  markdown: string;
}

const N = SUB_KEYS.length;
const SUB_INDEX: Record<string, number> = Object.fromEntries(SUB_KEYS.map((k, i) => [k, i]));
export const TIE_WEIGHTS: Partial<Record<SubKey, number>> = {
  atk_pct: 0.03,
  hp_pct: 0.025,
  def_pct: 0.02,
  effect_hit: 0.015,
  effect_res: 0.01,
  break_effect: 0.012,
  crit_rate: 0.02,
  crit_dmg: 0.02,
  spd: 0.02,
  atk: 0.002,
  hp: 0.002,
  def: 0.002,
};

function startOf(input: PlanInput, slot: Slot): 3 | 4 {
  const s = input.start;
  if (s === 3 || s === 4) return s;
  return (s && s[slot]) || 4;
}

function allowedSubs(slot: Slot, main: string, forbid: SubKey[] | undefined): boolean[] {
  return SUB_KEYS.map((k) => k !== (main as string) && !(forbid ?? []).includes(k));
}

interface Ctx {
  slots: { slot: Slot; main: string; start: 3 | 4; R: number; allowed: boolean[] }[];
  delta: number[]; // 1롤당 최종 스탯 증가량
  statOf: string[]; // 롤이 올리는 스탯
  current: Record<string, number>;
  weights: number[];
  targets: { stat: string; min?: number; max?: number }[];
  objective: PlanInput['objective'];
  dpsBase: number;
  big: number;
}

function evalFinal(ctx: Ctx, T: Float64Array): Record<string, number> {
  const f: Record<string, number> = { ...ctx.current };
  for (let i = 0; i < N; i++) if (T[i]) f[ctx.statOf[i]] = (f[ctx.statOf[i]] ?? 0) + T[i] * ctx.delta[i];
  return f;
}

function energy(ctx: Ctx, T: Float64Array): { E: number; feasible: boolean; obj: number } {
  const f = evalFinal(ctx, T);
  let pen = 0;
  let feasible = true;
  for (const t of ctx.targets) {
    if (t.min != null) {
      const sh = t.min - (f[t.stat] ?? 0);
      if (sh > 1e-9) {
        feasible = false;
        let md = 0;
        for (let i = 0; i < N; i++) if (ctx.statOf[i] === t.stat) md = Math.max(md, ctx.delta[i]);
        const rolls = md > 0 ? sh / md : sh;
        pen += ctx.big * (1 + rolls * rolls);
      }
    }
    if (t.max != null) {
      // 상한도 지켜야 하는 조건이다(속도가 파티 순서를 뒤집는 경우 등). 주옵션·기초 값만으로 이미 넘었다면 롤을 하나도 얹지 않는 쪽이 가장 덜 어긋난다.
      const ex = (f[t.stat] ?? 0) - t.max;
      if (ex > 1e-9) {
        feasible = false;
        let md = 0;
        for (let i = 0; i < N; i++) if (ctx.statOf[i] === t.stat && ctx.delta[i] > 0) md = md === 0 ? ctx.delta[i] : Math.min(md, ctx.delta[i]);
        const rolls = md > 0 ? ex / md : ex;
        pen += ctx.big * (1 + rolls * rolls);
      }
    }
  }
  let obj = 0;
  if (ctx.objective?.type === 'dps') {
    const stat = ctx.objective.stat ?? 'atk';
    const cr = Math.min(Math.max(f.crit_rate ?? 0, 0), 100) / 100;
    const cd = (f.crit_dmg ?? 0) / 100;
    const sc = f[stat] ?? 0;
    const score = sc * (1 + cr * cd);
    obj = 100 * Math.log(Math.max(score, 1e-9) / ctx.dpsBase);
    for (let i = 0; i < N; i++) obj += T[i] * (TIE_WEIGHTS[SUB_KEYS[i]] ?? 0);
    // 속도/효과명중 등 dps 외 스탯은 targets로 제어
  } else {
    for (let i = 0; i < N; i++) {
      let eff = T[i];
      const st = ctx.statOf[i];
      for (const t of ctx.targets) {
        if (t.stat === st && t.max != null && ctx.delta[i] > 0) {
          const capRolls = Math.max(0, (t.max - (ctx.current[st] ?? 0)) / ctx.delta[i]);
          eff = Math.min(eff, capRolls);
        }
      }
      obj += ctx.weights[i] * eff;
    }
  }
  return { E: -obj + pen, feasible, obj };
}

function randInt(rng: () => number, n: number) {
  return Math.floor(rng() * n);
}

function initPiece(rng: () => number, x: Int8Array, base: number, allowed: boolean[], R: number, bias: number[]) {
  const cand = SUB_KEYS.map((_, i) => i).filter((i) => allowed[i]);
  // 가중 무작위 4종 뽑기
  const pick: number[] = [];
  const pool = cand.slice();
  while (pick.length < 4 && pool.length) {
    const tot = pool.reduce((a, i) => a + 0.2 + bias[i], 0);
    let r = rng() * tot;
    let k = 0;
    for (; k < pool.length; k++) {
      r -= 0.2 + bias[pool[k]];
      if (r <= 0) break;
    }
    pick.push(pool.splice(Math.min(k, pool.length - 1), 1)[0]);
  }
  for (const i of pick) x[base + i] = 1;
  let left = R - pick.length;
  let guard = 0;
  while (left > 0 && guard++ < 200) {
    const i = pick[randInt(rng, pick.length)];
    if (x[base + i] < 6) {
      x[base + i]++;
      left--;
    }
  }
}

function anneal(ctx: Ctx, seed: number, iters: number, restarts: number): { x: Int8Array; E: number; feasible: boolean; obj: number } {
  const rng = mulberry32(seed);
  const nP = ctx.slots.length;
  const bias = ctx.weights.map((w, i) => Math.max(0, w) + (ctx.targets.some((t) => t.stat === ctx.statOf[i] && t.min != null) ? 1 : 0));
  let best: { x: Int8Array; E: number; feasible: boolean; obj: number } | null = null;
  const pool: { x: Int8Array; E: number; feasible: boolean; obj: number }[] = [];
  const wMean = Math.max(0.05, ctx.weights.reduce((a, b) => a + b, 0) / Math.max(1, ctx.weights.filter((w) => w > 0).length));

  for (let rs = 0; rs < restarts; rs++) {
    const x = new Int8Array(nP * N);
    const T = new Float64Array(N);
    for (let p = 0; p < nP; p++) initPiece(rng, x, p * N, ctx.slots[p].allowed, ctx.slots[p].R, bias);
    for (let p = 0; p < nP; p++) for (let i = 0; i < N; i++) T[i] += x[p * N + i];
    let cur = energy(ctx, T);
    let localBest = { x: x.slice(), ...cur };
    const T0 = (ctx.objective?.type === 'dps' ? 1.2 : wMean) * 1.2;
    const T1 = T0 * 0.01;
    for (let it = 0; it < iters; it++) {
      const temp = T0 * Math.pow(T1 / T0, it / iters);
      const p = randInt(rng, nP);
      const base = p * N;
      const act: number[] = [];
      for (let i = 0; i < N; i++) if (x[base + i] > 0) act.push(i);
      const changes: [number, number][] = [];
      const roll = rng();
      if (roll < 0.4) {
        // shift: a에서 한 롤을 b로 이동
        const aCand = act.filter((i) => x[base + i] >= 2);
        const bCand = act.filter((i) => x[base + i] <= 5);
        if (!aCand.length || bCand.length < 1) continue;
        const a = aCand[randInt(rng, aCand.length)];
        const bb = bCand.filter((i) => i !== a);
        if (!bb.length) continue;
        const b = bb[randInt(rng, bb.length)];
        changes.push([a, -1], [b, 1]);
      } else {
        // replace: 활성 부옵션 a를 비활성 부옵션 b로 교체. 롤은 b가 k개 가져가고 남는 롤(cnt-k)은 다른 활성 부옵션 c가 받는다
        const inactive: number[] = [];
        for (let i = 0; i < N; i++) if (x[base + i] === 0 && ctx.slots[p].allowed[i]) inactive.push(i);
        if (!inactive.length) continue;
        const a = act[randInt(rng, act.length)];
        const b = inactive[randInt(rng, inactive.length)];
        const cnt = x[base + a];
        const k = roll < 0.65 ? cnt : 1 + randInt(rng, cnt);
        changes.push([a, -cnt], [b, k]);
        if (k < cnt) {
          const cs = act.filter((i) => i !== a && x[base + i] + (cnt - k) <= 6);
          if (!cs.length) continue;
          changes.push([cs[randInt(rng, cs.length)], cnt - k]);
        }
      }
      for (const [i, d] of changes) {
        x[base + i] += d;
        T[i] += d;
      }
      const nxt = energy(ctx, T);
      const dE = nxt.E - cur.E;
      if (dE <= 0 || rng() < Math.exp(-dE / temp)) {
        cur = nxt;
        if (cur.E < localBest.E - 1e-12) localBest = { x: x.slice(), ...cur };
      } else {
        for (const [i, d] of changes) {
          x[base + i] -= d;
          T[i] -= d;
        }
      }
    }
    const polished = polish(ctx, localBest.x);
    pool.push(polished);
    if (!best || polished.E < best.E - 1e-12) best = polished;
  }
  // 한 부위만 바꾸면 손해지만 두 부위를 함께 바꾸면 이득인 경우(예: 목표용 롤을 다른 부위로 옮기기)는 쌍 이동으로 찾는다
  pool.sort((a, b) => a.E - b.E);
  for (const cand of pool.slice(0, 3)) {
    const r = pairPolish(ctx, cand.x);
    if (r.E < best!.E - 1e-12) best = r;
  }
  return best!;
}

function totalsOf(ctx: Ctx, x: Int8Array): Float64Array {
  const T = new Float64Array(N);
  for (let p = 0; p < ctx.slots.length; p++) for (let i = 0; i < N; i++) T[i] += x[p * N + i];
  return T;
}

/** 최속강하: 개선되는 이동(롤 이동 / 부옵션 교체 / 교체+롤 재분배)이 없을 때까지 전부 시도 */
function polish(ctx: Ctx, x0: Int8Array): { x: Int8Array; E: number; feasible: boolean; obj: number } {
  const x = x0.slice();
  const T = totalsOf(ctx, x);
  let cur = energy(ctx, T);
  const apply = (base: number, ch: [number, number][], sign: 1 | -1) => {
    for (const [i, d] of ch) {
      x[base + i] += sign * d;
      T[i] += sign * d;
    }
  };
  const tryMove = (base: number, ch: [number, number][]): boolean => {
    apply(base, ch, 1);
    const nx = energy(ctx, T);
    if (nx.E < cur.E - 1e-12) {
      cur = nx;
      return true;
    }
    apply(base, ch, -1);
    return false;
  };
  for (let round = 0; round < 60; round++) {
    let improved = false;
    for (let p = 0; p < ctx.slots.length; p++) {
      const base = p * N;
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          if (x[base + a] === 0) break;
          if (a === b || !ctx.slots[p].allowed[b]) continue;
          const cnt = x[base + a];
          if (x[base + b] === 0) {
            // 교체: b가 k롤을 가져가고 남는 cnt-k롤은 다른 활성 부옵션 c가 받는다(k=cnt면 단순 교체)
            for (let k = cnt; k >= 1 && x[base + a] === cnt; k--) {
              if (k === cnt) {
                if (tryMove(base, [[a, -cnt], [b, k]])) improved = true;
                continue;
              }
              for (let c = 0; c < N && x[base + a] === cnt; c++) {
                if (c === a || c === b || x[base + c] === 0 || x[base + c] + (cnt - k) > 6) continue;
                if (tryMove(base, [[a, -cnt], [b, k], [c, cnt - k]])) improved = true;
              }
            }
          } else if (cnt >= 2 && x[base + b] <= 5) {
            if (tryMove(base, [[a, -1], [b, 1]])) improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
  return { x, ...cur };
}

type Move = [number, number][];

/** 한 부위에서 가능한 모든 이동(롤 이동 / 부옵션 교체 / 교체+남는 롤 재분배) */
function genMoves(x: Int8Array, base: number, allowed: boolean[]): Move[] {
  const moves: Move[] = [];
  const act: number[] = [];
  const inactive: number[] = [];
  for (let i = 0; i < N; i++) {
    if (x[base + i] > 0) act.push(i);
    else if (allowed[i]) inactive.push(i);
  }
  for (const a of act) {
    const cnt = x[base + a];
    if (cnt >= 2) for (const b of act) if (b !== a && x[base + b] <= 5) moves.push([[a, -1], [b, 1]]);
    for (const b of inactive) {
      moves.push([[a, -cnt], [b, cnt]]);
      for (let k = 1; k < cnt; k++) for (const c of act) if (c !== a && x[base + c] + (cnt - k) <= 6) moves.push([[a, -cnt], [b, k], [c, cnt - k]]);
    }
  }
  return moves;
}

/** 서로 다른 두 부위의 이동을 동시에 적용해 보고 더 좋아지면 채택한다. 더 좋아지는 쌍이 없을 때까지 반복. */
function pairPolish(ctx: Ctx, x0: Int8Array): { x: Int8Array; E: number; feasible: boolean; obj: number } {
  const x = x0.slice();
  const T = totalsOf(ctx, x);
  let cur = energy(ctx, T);
  const apply = (base: number, m: Move, sign: 1 | -1) => {
    for (const [i, d] of m) {
      x[base + i] += sign * d;
      T[i] += sign * d;
    }
  };
  const nP = ctx.slots.length;
  for (let round = 0; round < 12; round++) {
    let improved = false;
    outer: for (let p = 0; p < nP; p++) {
      const movesP = genMoves(x, p * N, ctx.slots[p].allowed);
      for (let q = p + 1; q < nP; q++) {
        const movesQ = genMoves(x, q * N, ctx.slots[q].allowed);
        for (const mp of movesP) {
          apply(p * N, mp, 1);
          for (const mq of movesQ) {
            apply(q * N, mq, 1);
            const nx = energy(ctx, T);
            if (nx.E < cur.E - 1e-9) {
              cur = nx;
              improved = true;
              break outer;
            }
            apply(q * N, mq, -1);
          }
          apply(p * N, mp, -1);
        }
      }
    }
    if (!improved) break;
    // 쌍 이동 뒤에는 단일 이동으로 다듬는다
    const pol = polish(ctx, x);
    x.set(pol.x);
    T.set(totalsOf(ctx, x));
    cur = energy(ctx, T);
  }
  return { x, ...cur };
}

function buildMain(input: PlanInput): Record<Slot, string> {
  const m = {} as Record<Slot, string>;
  for (const s of SLOTS) {
    m[s] = input.main[s] ?? (s === 'head' ? 'hp' : s === 'hands' ? 'atk' : '');
  }
  return m;
}

export function planRelics(input: PlanInput): PlanResult {
  const notes: string[] = [];
  const quality = input.quality ?? 'avg';
  const main = buildMain(input);
  for (const s of SLOTS) {
    if (!main[s]) throw new Error(`${SLOT_KO[s]}의 주옵션(main.${s})을 지정해 주세요.`);
    if (!MAIN_OPTIONS[s].includes(main[s])) throw new Error(`${SLOT_KO[s]}에는 주옵션 "${main[s]}"을(를) 쓸 수 없습니다. 가능: ${MAIN_OPTIONS[s].join(', ')}`);
  }
  for (const t of input.targets ?? []) {
    if (t.min != null && t.max != null && t.min > t.max) throw new Error(`targets(${t.stat}): min(${t.min})이 max(${t.max})보다 큽니다. 하한은 상한 이하여야 합니다.`);
  }
  const mainOnly: Partial<Record<Slot, RelicPieceInput>> = {};
  for (const s of SLOTS) mainOnly[s] = { main: main[s], subs: {}, start: startOf(input, s), quality };

  const baseInput: BuildInput = {
    name: input.name,
    base: input.base,
    light_cone: input.light_cone,
    base_extra: input.base_extra,
    modifiers: input.modifiers,
    relics: mainOnly,
    quality,
  };
  const baseCalc = calcBuild(baseInput);
  const current = { ...baseCalc.final };
  const { computed } = resolveModifiers(baseInput, relicToModifiers(mainOnly, quality, []).mods);
  const baseTotals = computed.baseTotals;

  const delta: number[] = [];
  const statOf: string[] = [];
  for (const k of SUB_KEYS) {
    const sr = SUB_ROLL[k];
    const v = subRollValue(k, quality);
    statOf.push(sr.stat);
    if (sr.unit === 'pct' && (sr.stat === 'hp' || sr.stat === 'atk' || sr.stat === 'def')) delta.push(((baseTotals[sr.stat] ?? 0) * v) / 100);
    else delta.push(v);
  }

  const weights = SUB_KEYS.map((k) => input.weights?.[k] ?? 0);
  const hasWeights = weights.some((w) => w > 0);
  const objective = input.objective ?? { type: 'weights' as const };
  if (objective.type === 'weights' && !hasWeights) {
    notes.push('weights를 지정하지 않아 목표(targets)에 포함된 스탯의 롤에만 같은 가치를 두었습니다. 남는 롤 배치는 임의적입니다.');
    for (const t of input.targets ?? []) for (const k of SUB_KEYS) if (SUB_ROLL[k].stat === t.stat) weights[SUB_INDEX[k]] = Math.max(weights[SUB_INDEX[k]], 1);
  }
  for (let i = 0; i < N; i++) weights[i] += objective.type === 'dps' ? 0 : TIE_WEIGHTS[SUB_KEYS[i]] ?? 0;

  const slots = SLOTS.map((slot) => {
    const start = startOf(input, slot);
    return { slot, main: main[slot], start, R: rollsCap(start), allowed: allowedSubs(slot, main[slot], input.forbid?.[slot]) };
  });

  // 도달 가능 상한 계산
  const maxRollsFor = (stat: string): number => {
    let total = 0;
    for (const sl of slots) {
      let best = 0;
      for (let i = 0; i < N; i++) if (statOf[i] === stat && sl.allowed[i]) best = Math.max(best, Math.min(6, sl.R - 3));
      total += best;
    }
    return total;
  };

  const dpsStat = (objective.type === 'dps' ? objective.stat ?? 'atk' : 'atk') as string;
  const dpsBase = Math.max(1e-6, (current[dpsStat] ?? 1) * (1 + (Math.min(current.crit_rate ?? 0, 100) / 100) * ((current.crit_dmg ?? 0) / 100)));

  const origTargets: Target[] = (input.targets ?? []).map((t) => ({ stat: t.stat, min: t.min, max: t.max, label: t.label }));
  const bump: Record<string, number> = {};
  const effort = Math.max(1, Math.min(6, input.effort ?? 3));
  let finalX: Int8Array | null = null;
  let feasible = false;
  let calc: CalcResult | null = null;
  let objVal = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    const targets = origTargets.map((t) => ({ stat: t.stat, min: t.min != null ? t.min + (bump[t.stat] ?? 0) : undefined, max: t.max }));
    const ctx: Ctx = {
      slots,
      delta,
      statOf,
      current,
      weights,
      targets,
      objective,
      dpsBase,
      big: 1000 * (weights.reduce((a, b) => a + b, 0) + 5),
    };
    const res = anneal(ctx, (input.seed ?? 20261003) + attempt * 7919, 9000 * effort, 6 + effort * 2);
    finalX = res.x;
    objVal = res.obj;
    const relics = xToRelics(slots, res.x, quality);
    calc = calcBuild({ ...baseInput, relics, targets: origTargets });
    feasible = calc.target_checks.every((c) => c.ok);
    const low = calc.target_checks.filter((c) => c.status === 'below_min');
    if (feasible || !res.feasible || !low.length) break;
    // 2차 효과(scale 보너스 등)로 실제 값이 모델보다 낮게 나온 경우: 목표를 그만큼 올려 재탐색
    for (const f of low) bump[f.stat] = (bump[f.stat] ?? 0) + (f.min! - f.actual) + 1e-6;
  }

  const relics = xToRelics(slots, finalX!, quality);
  if (!calc) calc = calcBuild({ ...baseInput, relics });
  const shortfalls = (calc.target_checks ?? [])
    .filter((c) => c.status === 'below_min')
    .map((c) => ({ stat: c.stat, need: c.min!, actual: c.actual, max_possible: r2((current[c.stat] ?? 0) + maxRollsFor(c.stat) * Math.max(0, ...SUB_KEYS.map((k, i) => (statOf[i] === c.stat ? delta[i] : 0))), 3) }));
  const overshoots = (calc.target_checks ?? [])
    .filter((c) => c.status === 'above_max')
    .map((c) => ({ stat: c.stat, max: c.max!, actual: c.actual, min_possible: r2(current[c.stat] ?? 0, 3) }));
  if (shortfalls.length) notes.push('하한을 만족하는 배분을 찾지 못했습니다. shortfalls의 max_possible(도달 가능한 최대치)을 보고 목표를 낮추거나 주옵션(예: 발 속도, 끈 에너지 충전 효율)을 바꾸세요.');
  if (overshoots.length) {
    notes.push(
      '상한을 넘었습니다. overshoots의 min_possible은 부옵션을 하나도 안 얹었을 때의 값입니다 — 그 값이 이미 상한 이상이면 주옵션·세트·기초 값 때문이므로 상한을 올리거나 주옵션을 바꾸세요. 그렇지 않다면 하한~상한 폭이 롤 한 번의 크기(속도 2.3 등)보다 좁아 롤 단위로 맞출 수 없는 것입니다.',
    );
  }

  const planSlots: PlanSlot[] = slots.map((sl, p) => {
    const subs = SUB_KEYS.map((k, i) => ({ key: k, ko: SUB_KO[k], rolls: finalX![p * N + i] }))
      .filter((s) => s.rolls > 0)
      .sort((a, b) => b.rolls - a.rolls);
    return { slot: sl.slot, slot_ko: SLOT_KO[sl.slot], main: sl.main, start: sl.start, rolls_total: subs.reduce((a, s) => a + s.rolls, 0), subs };
  });
  const totals = SUB_KEYS.map((k, i) => ({ key: k, ko: SUB_KO[k], rolls: planSlots.reduce((a, s) => a + (s.subs.find((x) => x.key === k)?.rolls ?? 0), 0) })).filter((t) => t.rolls > 0).sort((a, b) => b.rolls - a.rolls);

  const md: string[] = [];
  md.push('| 부위 | 주옵션 | 부옵션 배분(롤 횟수) | 롤 합계 |', '|:--|:--|:--|--:|');
  for (const s of planSlots) md.push(`| ${s.slot_ko} | ${calc.relic_summary.find((r) => r.slot === s.slot)?.main_ko ?? s.main} | ${s.subs.map((x) => `${x.ko} ×${x.rolls}`).join(', ')} | ${s.rolls_total}/${rollsCap(s.start)} |`);
  md.push('', `전체 롤 합계: ${totals.map((t) => `${t.ko} ${t.rolls}회`).join(', ')}`);

  return { feasible, slots: planSlots, totals, relics, calc, objective_value: r2(objVal, 3), shortfalls, overshoots, notes, markdown: md.join('\n') };
}

function xToRelics(slots: Ctx['slots'], x: Int8Array, quality: Quality): Partial<Record<Slot, RelicPieceInput>> {
  const out: Partial<Record<Slot, RelicPieceInput>> = {};
  slots.forEach((sl, p) => {
    const subs: Partial<Record<SubKey, number>> = {};
    SUB_KEYS.forEach((k, i) => {
      if (x[p * N + i] > 0) subs[k] = x[p * N + i];
    });
    out[sl.slot] = { main: sl.main, subs, start: sl.start, quality };
  });
  return out;
}

export { STAT_KO };
