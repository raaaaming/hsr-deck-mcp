// 행동 수치(AV) 시뮬레이터: 속도 → 행동 순서, 행동 앞당김/지연, 속도 증감 이벤트를 반영한 타임라인.
//  거리(distance) 방식: 각 유닛은 10000 거리를 속도로 소모. 속도가 중간에 바뀌어도 남은 거리는 보존된다.
//  사이클 0 = 0~150 AV, 사이클 n(n≥1) = 150+100(n-1) ~ 150+100n AV.

import { r2 } from './util';

export interface TurnUnit {
  name: string;
  spd: number;
  /** 전투 시작 시 행동 앞당김(%) — 비술/패시브 등 */
  start_advance_pct?: number;
  /** 동속일 때 우선순위(작을수록 먼저). 기본은 입력 순서 */
  priority?: number;
}

export interface TurnEvent {
  /** 이 유닛이 nth번째로 행동한 직후(nth 생략 시 매 행동 직후, every 지정 시 N번에 한 번) */
  after: { actor: string; nth?: number; every?: number };
  target: string;
  kind: 'advance' | 'delay' | 'spd_add' | 'spd_pct' | 'spd_set';
  value: number;
  /** spd_* 효과가 유지되는 대상의 행동 횟수(생략 시 영구) */
  duration?: number;
  note?: string;
}

export interface TurnInput {
  units: TurnUnit[];
  events?: TurnEvent[];
  max_av?: number;
  max_actions?: number;
}

export interface TimelineEntry {
  n: number;
  av: number;
  cycle: number;
  actor: string;
  spd: number;
  notes: string[];
}

export interface TurnResult {
  timeline: TimelineEntry[];
  per_cycle: { cycle: number; actions: Record<string, number> }[];
  first_actions_av: Record<string, number>;
  markdown: string;
  warnings: string[];
}

export function cycleOf(av: number): number {
  if (av <= 150 + 1e-9) return 0;
  return Math.ceil((av - 150) / 100 - 1e-9);
}

interface UnitState {
  def: TurnUnit;
  idx: number;
  spd: number;
  baseSpd: number;
  dist: number;
  acts: number;
  buffs: { kind: 'add' | 'pct'; value: number; left: number }[];
  setSpd?: { value: number; left: number };
}

function currentSpd(u: UnitState): number {
  if (u.setSpd) return u.setSpd.value;
  let s = u.baseSpd;
  let pct = 0;
  let add = 0;
  for (const b of u.buffs) {
    if (b.kind === 'pct') pct += b.value;
    else add += b.value;
  }
  s = s * (1 + pct / 100) + add;
  return Math.max(1, s);
}

export function simulateTurns(input: TurnInput): TurnResult {
  const warnings: string[] = [];
  const maxAv = input.max_av ?? 450;
  const maxActions = input.max_actions ?? 80;
  const units: UnitState[] = input.units.map((d, idx) => ({
    def: d,
    idx,
    baseSpd: d.spd,
    spd: d.spd,
    dist: 10000 * (1 - Math.min(100, Math.max(0, d.start_advance_pct ?? 0)) / 100),
    acts: 0,
    buffs: [],
  }));
  const byName = new Map(units.map((u) => [u.def.name, u]));
  for (const e of input.events ?? []) {
    if (!byName.has(e.after.actor)) warnings.push(`이벤트의 actor "${e.after.actor}"가 유닛 목록에 없습니다.`);
    if (!byName.has(e.target)) warnings.push(`이벤트의 target "${e.target}"가 유닛 목록에 없습니다.`);
  }

  let t = 0;
  const timeline: TimelineEntry[] = [];
  const first: Record<string, number> = {};
  while (timeline.length < maxActions) {
    for (const u of units) u.spd = currentSpd(u);
    // 다음 행동자
    let best: UnitState | null = null;
    let bestT = Infinity;
    for (const u of units) {
      const tt = u.dist / u.spd;
      const better =
        tt < bestT - 1e-9 ||
        (Math.abs(tt - bestT) <= 1e-9 && best && (u.def.priority ?? u.idx) < (best.def.priority ?? best.idx));
      if (better) {
        best = u;
        bestT = tt;
      }
    }
    if (!best) break;
    const dt = bestT;
    if (t + dt > maxAv + 1e-9) break;
    for (const u of units) u.dist = Math.max(0, u.dist - u.spd * dt);
    t += dt;
    best.dist = 10000;
    best.acts++;
    const notes: string[] = [];
    const entry: TimelineEntry = { n: timeline.length + 1, av: r2(t, 2), cycle: cycleOf(t), actor: best.def.name, spd: r2(best.spd, 2), notes };
    if (first[best.def.name] == null) first[best.def.name] = r2(t, 2);

    // 이 유닛의 지속 효과 차감 (자신의 행동 종료 시)
    for (const b of best.buffs) b.left--;
    best.buffs = best.buffs.filter((b) => b.left > 0 || !isFinite(b.left));
    if (best.setSpd && isFinite(best.setSpd.left)) {
      best.setSpd.left--;
      if (best.setSpd.left <= 0) best.setSpd = undefined;
    }

    for (const e of input.events ?? []) {
      if (e.after.actor !== best.def.name) continue;
      const nth = e.after.nth;
      const every = e.after.every;
      if (nth != null && best.acts !== nth) continue;
      if (every != null && best.acts % every !== 0) continue;
      const tg = byName.get(e.target);
      if (!tg) continue;
      const tag = e.note ?? `${e.target} ${e.kind} ${e.value}`;
      if (e.kind === 'advance') tg.dist = Math.max(0, tg.dist - (e.value / 100) * 10000);
      else if (e.kind === 'delay') tg.dist = Math.min(10000, tg.dist + (e.value / 100) * 10000);
      else if (e.kind === 'spd_add') tg.buffs.push({ kind: 'add', value: e.value, left: e.duration ?? Infinity });
      else if (e.kind === 'spd_pct') tg.buffs.push({ kind: 'pct', value: e.value, left: e.duration ?? Infinity });
      else if (e.kind === 'spd_set') tg.setSpd = { value: e.value, left: e.duration ?? Infinity };
      notes.push(tag);
    }
    timeline.push(entry);
  }

  const cycles = new Map<number, Record<string, number>>();
  for (const e of timeline) {
    const row = cycles.get(e.cycle) ?? {};
    row[e.actor] = (row[e.actor] ?? 0) + 1;
    cycles.set(e.cycle, row);
  }
  const per_cycle = [...cycles.entries()].sort((a, b) => a[0] - b[0]).map(([cycle, actions]) => ({ cycle, actions }));

  const names = input.units.map((u) => u.name);
  const md: string[] = [];
  md.push(`| 사이클 | ${names.join(' | ')} |`, `|:--|${names.map(() => '--:').join('|')}|`);
  for (const c of per_cycle) md.push(`| ${c.cycle} | ${names.map((n) => c.actions[n] ?? 0).join(' | ')} |`);
  md.push('', '| # | AV | 사이클 | 행동자 | 메모 |', '|--:|--:|--:|:--|:--|');
  for (const e of timeline) md.push(`| ${e.n} | ${e.av} | ${e.cycle} | ${e.actor} | ${e.notes.join('; ')} |`);

  return { timeline, per_cycle, first_actions_av: first, markdown: md.join('\n'), warnings };
}
