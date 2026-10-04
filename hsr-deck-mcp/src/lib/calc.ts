// 스탯 합산 계산기.
//  HP/공격력/방어력 = (캐릭터 기초 + 광추 기초) × (1 + Σ%) + Σ고정값
//  속도            = 캐릭터 기초 속도 × (1 + Σ%) + Σ고정값
//  그 밖의 스탯     = 기본값 + Σ(%p)
// 모든 보너스는 modifier로 표현하고 group(출처)별 기여량을 표로 보여준다.

import {
  MAIN_KO,
  MAIN_VALUE,
  MAIN_OPTIONS,
  Quality,
  RELIC_RULES,
  SLOTS,
  SLOT_KO,
  SUB_KEYS,
  SUB_KO,
  SUB_ROLL,
  Slot,
  SubKey,
  mainValue,
  rollsCap,
  subRollValue,
} from './relicdata';
import { STAT_KO } from './stats';
import { r2 } from './util';

export interface ScaleSpec {
  /** 기준이 되는 최종 스탯 키 (예: 'def') */
  from: string;
  /** 이 값 이상일 때만 적용 (기본 0) */
  threshold?: number;
  /** 몇 pt마다 per를 더하는지 (기본 1) */
  step?: number;
  /** step마다 더해지는 양 */
  per?: number;
  /** 임계값을 넘으면 기본으로 주어지는 양 */
  base?: number;
  /** 초과분 계산 상한 */
  cap_over?: number;
  /** 구간(floor) 계산 여부 (기본 true) */
  floor?: boolean;
}

export interface Modifier {
  stat: string;
  value?: number;
  unit?: 'pct' | 'flat';
  group?: string;
  label?: string;
  scale?: ScaleSpec;
}

export interface RelicPieceInput {
  main: string;
  /** 부옵션 키 → 롤 횟수 */
  subs?: Partial<Record<SubKey, number>>;
  /** 초기 부옵션 수(4개면 총 9롤, 3개면 8롤) */
  start?: 3 | 4;
  quality?: Quality;
}

export interface Target {
  stat: string;
  min?: number;
  max?: number;
  label?: string;
}

export interface BuildInput {
  name?: string;
  base: { hp: number; atk: number; def: number; spd: number; [k: string]: number | undefined };
  light_cone?: { hp?: number; atk?: number; def?: number } | null;
  base_extra?: Record<string, number>;
  modifiers?: Modifier[];
  relics?: Partial<Record<Slot, RelicPieceInput>>;
  quality?: Quality;
  targets?: Target[];
}

export const GROUP_ORDER = [
  'minor_traces',
  'major_traces',
  'eidolon',
  'lc_passive',
  'relic_main',
  'relic_sub',
  'relic_set',
  'team_buff',
  'other',
];
export const GROUP_KO: Record<string, string> = {
  base: '캐릭터 기본',
  lc_base: '광추 기본',
  minor_traces: '작은 행적',
  major_traces: '큰 행적(추가 능력)',
  eidolon: '성혼',
  lc_passive: '광추 효과',
  relic_main: '유물 주옵션',
  relic_sub: '유물 부옵션',
  relic_set: '세트 효과',
  team_buff: '파티 버프',
  other: '기타',
};

const DEFAULT_BASE: Record<string, number> = {
  crit_rate: 5,
  crit_dmg: 50,
  energy_regen: 100,
  effect_hit: 0,
  effect_res: 0,
  break_effect: 0,
  outgoing_healing: 0,
  elemental_dmg: 0,
  elation: 0,
};

const BASE_SCALED = new Set(['hp', 'atk', 'def']);

interface FlatMod {
  stat: string;
  value: number;
  unit: 'pct' | 'flat';
  group: string;
  label?: string;
}

export interface CalcRow {
  stat: string;
  stat_ko: string;
  base: number;
  lc_base: number;
  groups: Record<string, number>;
  final: number;
}

export interface TargetCheck {
  stat: string;
  label?: string;
  min?: number;
  max?: number;
  actual: number;
  ok: boolean;
  /** ok: 충족 / below_min: 하한 미달 / above_max: 상한 초과 */
  status: 'ok' | 'below_min' | 'above_max';
  /** 하한 대비 여유(min이 없으면 상한 대비). 상한을 넘으면 음수 */
  margin: number;
}

export interface CalcResult {
  name?: string;
  final: Record<string, number>;
  rows: CalcRow[];
  groups_used: string[];
  relic_summary: {
    slot: Slot;
    slot_ko: string;
    main: string;
    main_ko: string;
    main_value: string;
    start: number;
    rolls_total: number;
    rolls_cap: number;
    subs: { key: string; ko: string; rolls: number; value: string }[];
  }[];
  resolved_scales: { stat: string; label?: string; value: number; from: string; from_value: number }[];
  target_checks: TargetCheck[];
  markdown: string;
  warnings: string[];
}

const trim = (n: number, d: number) => String(Math.round(n * 10 ** d) / 10 ** d);

export function fmtStat(stat: string, v: number, delta = false): string {
  const sign = delta && v > 0 ? '+' : '';
  if (stat === 'hp' || stat === 'atk' || stat === 'def') return sign + trim(v, 1);
  if (stat === 'spd') return sign + trim(v, 2);
  return sign + trim(v, 1) + '%';
}

export function fmtRoll(unit: 'flat' | 'pct', v: number): string {
  return unit === 'pct' ? `+${trim(v, 2)}%` : `+${trim(v, 1)}`;
}

export function evalScale(s: ScaleSpec, stats: Record<string, number>): number {
  const from = stats[s.from] ?? 0;
  const th = s.threshold ?? 0;
  if (from + 1e-9 < th) return 0;
  let over = from - th;
  if (s.cap_over != null) over = Math.min(over, s.cap_over);
  const step = s.step && s.step > 0 ? s.step : 1;
  const n = s.floor === false ? over / step : Math.floor(over / step + 1e-9);
  return (s.base ?? 0) + (s.per ?? 0) * n;
}

export function relicToModifiers(
  relics: Partial<Record<Slot, RelicPieceInput>> | undefined,
  defaultQuality: Quality,
  warnings: string[],
): { mods: FlatMod[]; summary: CalcResult['relic_summary'] } {
  const mods: FlatMod[] = [];
  const summary: CalcResult['relic_summary'] = [];
  if (!relics) return { mods, summary };
  for (const slot of SLOTS) {
    const piece = relics[slot];
    if (!piece) continue;
    const mv = MAIN_VALUE[piece.main];
    if (!mv) {
      warnings.push(`${SLOT_KO[slot]}: 알 수 없는 주옵션 "${piece.main}"`);
      continue;
    }
    if (!MAIN_OPTIONS[slot].includes(piece.main)) warnings.push(`${SLOT_KO[slot]}: 주옵션 ${MAIN_KO[piece.main] ?? piece.main}은(는) 이 부위에서 선택할 수 없습니다.`);
    mods.push({ stat: mv.stat, value: mv.value, unit: mv.unit, group: 'relic_main', label: `${SLOT_KO[slot]} 주옵션 ${MAIN_KO[piece.main]}` });
    const q = piece.quality ?? defaultQuality;
    const start = piece.start ?? 4;
    let total = 0;
    const subs: CalcResult['relic_summary'][number]['subs'] = [];
    let distinct = 0;
    for (const [k, nRaw] of Object.entries(piece.subs ?? {})) {
      const n = Number(nRaw);
      if (!n) continue;
      if (!(SUB_KEYS as readonly string[]).includes(k)) {
        warnings.push(`${SLOT_KO[slot]}: 알 수 없는 부옵션 "${k}"`);
        continue;
      }
      const sk = k as SubKey;
      if (sk === (piece.main as string)) warnings.push(`${SLOT_KO[slot]}: 주옵션과 같은 부옵션(${SUB_KO[sk]})은 붙을 수 없습니다.`);
      if (n > 6) warnings.push(`${SLOT_KO[slot]}: ${SUB_KO[sk]} ${n}회 — 한 부품의 같은 부옵션 롤은 최대 6회입니다.`);
      total += n;
      distinct++;
      const per = subRollValue(sk, q);
      const sr = SUB_ROLL[sk];
      mods.push({ stat: sr.stat, value: per * n, unit: sr.unit, group: 'relic_sub', label: `${SLOT_KO[slot]} ${SUB_KO[sk]} ×${n}` });
      subs.push({ key: sk, ko: SUB_KO[sk], rolls: n, value: fmtRoll(sr.unit, per * n) });
    }
    const cap = rollsCap(start);
    if (distinct > 4) warnings.push(`${SLOT_KO[slot]}: 부옵션은 최대 4종입니다(현재 ${distinct}종).`);
    if (total > cap) warnings.push(`${SLOT_KO[slot]}: 총 롤 ${total}회가 한도(${cap}회, 초기 ${start}옵션)를 넘었습니다.`);
    summary.push({
      slot,
      slot_ko: SLOT_KO[slot],
      main: piece.main,
      main_ko: MAIN_KO[piece.main] ?? piece.main,
      main_value: mv.unit === 'flat' ? String(mv.value) : `${mv.value}%`,
      start,
      rolls_total: total,
      rolls_cap: cap,
      subs,
    });
  }
  return { mods, summary };
}

interface Computed {
  final: Record<string, number>;
  contrib: Record<string, Record<string, number>>; // stat → group → 기여(최종 단위)
  baseTotals: Record<string, number>;
}

function computeOnce(input: BuildInput, mods: FlatMod[]): Computed {
  const lc = input.light_cone ?? {};
  const baseChar: Record<string, number> = { ...DEFAULT_BASE, ...(input.base_extra ?? {}) };
  for (const [k, v] of Object.entries(input.base)) if (typeof v === 'number') baseChar[k] = v;
  const lcBase: Record<string, number> = { hp: lc.hp ?? 0, atk: lc.atk ?? 0, def: lc.def ?? 0 };

  const acc: Record<string, Record<string, { pct: number; flat: number }>> = {};
  for (const m of mods) {
    const byGroup = (acc[m.stat] ??= {});
    const g = (byGroup[m.group] ??= { pct: 0, flat: 0 });
    if (m.unit === 'flat') g.flat += m.value;
    else g.pct += m.value;
  }

  const final: Record<string, number> = {};
  const contrib: Record<string, Record<string, number>> = {};
  const baseTotals: Record<string, number> = {};
  const stats = new Set<string>([...Object.keys(baseChar), ...Object.keys(acc), 'hp', 'atk', 'def', 'spd']);
  for (const stat of stats) {
    const baseTotal = (baseChar[stat] ?? 0) + (BASE_SCALED.has(stat) ? (lcBase[stat] ?? 0) : 0);
    baseTotals[stat] = baseTotal;
    const byGroup = acc[stat] ?? {};
    let total = baseTotal;
    const c: Record<string, number> = {};
    for (const [group, v] of Object.entries(byGroup)) {
      let add: number;
      if (BASE_SCALED.has(stat) || stat === 'spd') add = (baseTotal * v.pct) / 100 + v.flat;
      else add = v.pct + v.flat;
      c[group] = add;
      total += add;
    }
    final[stat] = total;
    contrib[stat] = c;
  }
  return { final, contrib, baseTotals };
}

export function resolveModifiers(input: BuildInput, extra: FlatMod[]): { mods: FlatMod[]; scales: CalcResult['resolved_scales']; computed: Computed; converged: boolean } {
  const fixed: FlatMod[] = [...extra];
  const scaleMods: Modifier[] = [];
  for (const m of input.modifiers ?? []) {
    if (m.scale) scaleMods.push(m);
    else if (typeof m.value === 'number') fixed.push({ stat: m.stat, value: m.value, unit: m.unit ?? 'pct', group: m.group ?? 'other', label: m.label });
  }
  let computed = computeOnce(input, fixed);
  let resolved: FlatMod[] = [];
  let scales: CalcResult['resolved_scales'] = [];
  let converged = scaleMods.length === 0;
  for (let it = 0; it < 12; it++) {
    scales = [];
    resolved = scaleMods.map((m) => {
      const v = evalScale(m.scale!, computed.final);
      scales.push({ stat: m.stat, label: m.label, value: v, from: m.scale!.from, from_value: computed.final[m.scale!.from] ?? 0 });
      return { stat: m.stat, value: v, unit: m.unit ?? 'pct', group: m.group ?? 'other', label: m.label };
    });
    const next = computeOnce(input, [...fixed, ...resolved]);
    converged = Object.keys(next.final).every((k) => Math.abs(next.final[k] - (computed.final[k] ?? 0)) < 1e-7);
    computed = next;
    if (converged) break;
  }
  return { mods: [...fixed, ...resolved], scales, computed, converged };
}

const ROW_ORDER = ['hp', 'atk', 'def', 'spd', 'crit_rate', 'crit_dmg', 'break_effect', 'effect_hit', 'effect_res', 'energy_regen', 'outgoing_healing', 'elemental_dmg', 'elation'];

export function calcBuild(input: BuildInput): CalcResult {
  const warnings: string[] = [];
  const quality = input.quality ?? 'avg';
  for (const m of input.modifiers ?? []) {
    const tag = m.label ? `"${m.label}"` : `stat=${m.stat}`;
    if (typeof m.value !== 'number' && !m.scale) warnings.push(`modifier ${tag}: value(또는 scale)가 없어 반영되지 않았습니다.`);
    if (/_(pct|flat)$/.test(m.stat)) warnings.push(`modifier ${tag}: stat 키 "${m.stat}"는 부옵션 키입니다. 스탯 키(예: atk)와 unit('pct'|'flat')로 지정하세요. 이 항목은 어떤 스탯에도 반영되지 않습니다.`);
  }
  const { mods: relicMods, summary } = relicToModifiers(input.relics, quality, warnings);
  const { scales, computed, converged } = resolveModifiers(input, relicMods);
  if (!converged) warnings.push('스탯에 비례하는 보너스(scale)가 서로를 키우며 수렴하지 않았습니다. 입력(per/threshold)을 확인하세요. 마지막 반복 값을 표시합니다.');
  const { final, contrib, baseTotals } = computed;

  const lc = input.light_cone ?? {};
  const groupsPresent = new Set<string>();
  for (const stat of Object.keys(contrib)) for (const [g, v] of Object.entries(contrib[stat])) if (Math.abs(v) > 1e-9) groupsPresent.add(g);
  const groups = [...GROUP_ORDER.filter((g) => groupsPresent.has(g)), ...[...groupsPresent].filter((g) => !GROUP_ORDER.includes(g))];

  const rows: CalcRow[] = [];
  const statsPresent = ROW_ORDER.filter((s) => {
    if (['hp', 'atk', 'def', 'spd', 'crit_rate', 'crit_dmg', 'energy_regen'].includes(s)) return true;
    return Math.abs(final[s] ?? 0) > 1e-9;
  });
  for (const stat of [...statsPresent, ...Object.keys(final).filter((s) => !ROW_ORDER.includes(s) && Math.abs(final[s]) > 1e-9)]) {
    const baseChar = (input.base[stat] as number | undefined) ?? DEFAULT_BASE[stat] ?? input.base_extra?.[stat] ?? 0;
    const lcBase = BASE_SCALED.has(stat) ? ((lc as Record<string, number | undefined>)[stat] ?? 0) : 0;
    rows.push({
      stat,
      stat_ko: STAT_KO[stat] ?? stat,
      base: baseChar,
      lc_base: lcBase,
      groups: Object.fromEntries(groups.map((g) => [g, contrib[stat]?.[g] ?? 0])),
      final: final[stat] ?? 0,
    });
  }

  const checks: TargetCheck[] = (input.targets ?? []).map((t) => {
    const actual = final[t.stat] ?? 0;
    const okMin = t.min == null || actual + 1e-9 >= t.min;
    const okMax = t.max == null || actual - 1e-9 <= t.max;
    const status: TargetCheck['status'] = !okMin ? 'below_min' : !okMax ? 'above_max' : 'ok';
    const margin = status === 'above_max' ? t.max! - actual : t.min != null ? actual - t.min : t.max != null ? t.max - actual : 0;
    return { stat: t.stat, label: t.label, min: t.min, max: t.max, actual: r2(actual, 3), ok: okMin && okMax, status, margin: r2(margin, 3) };
  });

  const markdown = toMarkdown(input.name, rows, groups, summary, checks);
  return {
    name: input.name,
    final: Object.fromEntries(Object.entries(final).map(([k, v]) => [k, r2(v, 3)])),
    rows,
    groups_used: groups,
    relic_summary: summary,
    resolved_scales: scales.map((s) => ({ ...s, value: r2(s.value, 3), from_value: r2(s.from_value, 3) })),
    target_checks: checks,
    markdown,
    warnings,
  };
}

function cell(stat: string, v: number, signed: boolean): string {
  if (Math.abs(v) < 1e-9) return '–';
  return fmtStat(stat, v, signed);
}

function toMarkdown(name: string | undefined, rows: CalcRow[], groups: string[], summary: CalcResult['relic_summary'], checks: TargetCheck[]): string {
  const head = ['스탯', '캐릭터 기본', ...(rows.some((r) => r.lc_base) ? ['광추 기본'] : []), ...groups.map((g) => GROUP_KO[g] ?? g), '최종'];
  const hasLc = rows.some((r) => r.lc_base);
  const lines: string[] = [];
  if (name) lines.push(`**${name}**`, '');
  lines.push(`| ${head.join(' | ')} |`, `|${head.map((_, i) => (i === 0 ? ':--' : '--:')).join('|')}|`);
  for (const r of rows) {
    const cells = [r.stat_ko, fmtStat(r.stat, r.base)];
    if (hasLc) cells.push(cell(r.stat, r.lc_base, true));
    for (const g of groups) cells.push(cell(r.stat, r.groups[g] ?? 0, true));
    cells.push(`**${fmtStat(r.stat, r.final)}**`);
    lines.push(`| ${cells.join(' | ')} |`);
  }
  if (summary.length) {
    lines.push('', '| 부위 | 주옵션 | 부옵션(롤 횟수) | 롤 합계 |', '|:--|:--|:--|--:|');
    for (const s of summary) {
      lines.push(`| ${s.slot_ko} | ${s.main_ko} ${s.main_value} | ${s.subs.map((x) => `${x.ko} ×${x.rolls}`).join(', ') || '–'} | ${s.rolls_total}/${s.rolls_cap} |`);
    }
  }
  if (checks.length) {
    lines.push('', '| 목표 | 요구 | 실제 | 판정 |', '|:--|--:|--:|:--:|');
    for (const c of checks) {
      const req =
        c.min != null && c.max != null
          ? `${fmtStat(c.stat, c.min)} ~ ${fmtStat(c.stat, c.max)}`
          : c.min != null
            ? `≥ ${fmtStat(c.stat, c.min)}`
            : c.max != null
              ? `≤ ${fmtStat(c.stat, c.max)}`
              : '';
      lines.push(`| ${c.label ?? STAT_KO[c.stat] ?? c.stat} | ${req} | ${fmtStat(c.stat, c.actual)} | ${c.status === 'ok' ? '충족' : c.status === 'below_min' ? '미달' : '상한 초과'} |`);
    }
  }
  return lines.join('\n');
}

export { RELIC_RULES };
