// 선택적 보강: Mar-7th/StarRailRes (공개 JSON)로
//  - 위키가 정수로 내림한 Lv.80 기초 능력치를 소수점까지 보정
//  - 위키에 없는 필살기 에너지 비용(max_sp), 도발(taunt) 보강
//  - 위키 행적 설명에 값이 비어 있거나(예: "공격력" 만 적힘) 읽히지 않는 작은 행적을 게임 데이터로 보완/교차검증
// 실패하면 조용히 위키 값을 그대로 쓰고 warnings에만 남긴다.

import type { Fetcher } from './wiki';
import { BONUS_TOTAL_CAP, CharacterData, MinorTrace, SKILL_KIND_KO, SkillKind, recomputeSkillLevels, sumMinor } from './character';
import type { LightConeData } from './lightcone';
import { normName, r2 } from './util';

const BASE = 'https://raw.githubusercontent.com/Mar-7th/StarRailRes/master/index_min/kr/';

interface PromoValue {
  hp: { base: number; step: number };
  atk: { base: number; step: number };
  def: { base: number; step: number };
  spd?: { base: number; step: number };
  taunt?: { base: number; step: number };
}

export interface SrrData {
  chars: Record<string, any>;
  promos: Record<string, { values: PromoValue[] }>;
  lcs: Record<string, any>;
  lcPromos: Record<string, { values: PromoValue[] }>;
  /** 행적 노드(작은 행적 값). 파일이 없으면 null */
  trees: Record<string, any> | null;
  /** 성혼(rank) id → 오르는 스킬 목록(level_up_skills만 보관). 파일이 없으면 null */
  ranks: Record<string, { level_up_skills?: { id: string | number; num: number }[] }> | null;
  /** 스킬 id → 이름·종류(type). 성혼 보너스가 어느 종류 스킬에 붙는지 해석하는 데 쓴다. 파일이 없으면 null */
  skills: Record<string, { name: string; type: string }> | null;
  byCharName: Map<string, any[]>;
  byLcName: Map<string, any[]>;
}

export class SrrClient {
  private data: SrrData | null = null;
  private loadedAt = 0;
  private inflight: Promise<SrrData | null> | null = null;
  private lastFail = 0;

  constructor(
    private fetcher: Fetcher = (u, i) => fetch(u, i),
    private ttlMs = 6 * 3600_000,
  ) {}

  private async getJson(name: string): Promise<any> {
    const res = await this.fetcher(`${BASE}${name}.json`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`SRR ${name} HTTP ${res.status}`);
    return res.json();
  }

  clear() {
    this.data = null;
    this.loadedAt = 0;
  }

  private lastRefresh = 0;

  /**
   * TTL과 무관하게 다시 읽는다(StarRailRes에 새 캐릭터·광추가 추가됐는지 확인할 때).
   * GitHub를 두드리지 않도록 minIntervalMs 안에서는 기존 데이터를 그대로 돌려주고, 실패하면 이전 데이터를 유지한다.
   */
  async refresh(minIntervalMs = 30 * 60_000): Promise<SrrData | null> {
    if (Date.now() - this.lastRefresh < minIntervalMs) return this.load();
    this.lastRefresh = Date.now();
    this.loadedAt = 0;
    this.lastFail = 0;
    return this.load();
  }

  async load(): Promise<SrrData | null> {
    if (this.data && Date.now() - this.loadedAt < this.ttlMs) return this.data;
    if (Date.now() - this.lastFail < 5 * 60_000) return this.data; // 실패 직후엔 (있다면) 이전 데이터 재사용
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const [chars, promos, lcs, lcPromos, trees, ranksRaw, skillsRaw] = await Promise.all([
            this.getJson('characters'),
            this.getJson('character_promotions'),
            this.getJson('light_cones'),
            this.getJson('light_cone_promotions'),
            this.getJson('character_skill_trees').catch(() => null),
            this.getJson('character_ranks').catch(() => null),
            this.getJson('character_skills').catch(() => null),
          ]);
          // 두 파일은 크므로(스킬 수치표 포함) 필요한 필드만 남겨 메모리를 줄인다
          const ranks = ranksRaw
            ? Object.fromEntries(Object.entries<any>(ranksRaw).map(([k, v]) => [k, { level_up_skills: Array.isArray(v?.level_up_skills) ? v.level_up_skills : [] }]))
            : null;
          const skills = skillsRaw
            ? Object.fromEntries(Object.entries<any>(skillsRaw).map(([k, v]) => [k, { name: String(v?.name ?? ''), type: String(v?.type ?? '') }]))
            : null;
          const group = (o: Record<string, any>) => {
            const m = new Map<string, any[]>();
            for (const v of Object.values<any>(o)) {
              const k = normName(v.name);
              (m.get(k) ?? m.set(k, []).get(k)!).push(v);
            }
            return m;
          };
          this.data = { chars, promos, lcs, lcPromos, trees, ranks, skills, byCharName: group(chars), byLcName: group(lcs) };
          this.loadedAt = Date.now();
          return this.data;
        } catch {
          this.lastFail = Date.now();
          return this.data;
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }
}

const lv80 = (b: { base: number; step: number } | undefined) => (b ? b.base + b.step * 79 : null);

function pickMatch(cands: any[] | undefined, pred: (c: any) => boolean): any | null {
  if (!cands?.length) return null;
  return cands.find(pred) ?? (cands.length === 1 ? cands[0] : null);
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 이름 유사도(문자 2-그램 Dice 계수, 0~1). 위키와 SRR의 번역 표기 차이("따뜻한"/"따듯한")를 흡수한다. */
export function nameSimilarity(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (na === nb) return 1;
  const x = bigrams(na);
  const y = bigrams(nb);
  if (!x.length || !y.length) return 0;
  const m = new Map<string, number>();
  for (const g of x) m.set(g, (m.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of y) {
    const n = m.get(g) ?? 0;
    if (n > 0) {
      hit++;
      m.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

/** 후보 중 이름이 충분히 비슷하고 2등과 뚜렷하게 차이 나는 하나만 고른다(애매하면 null) */
export function fuzzyBest<T extends { name: string }>(name: string, cands: T[], min = 0.7, margin = 0.15): T | null {
  const scored = cands.map((c) => ({ c, s: nameSimilarity(name, String(c.name)) })).sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < min) return null;
  if (scored.length > 1 && scored[0].s - scored[1].s < margin) return null;
  return scored[0].c;
}

/** 위키 캐릭터 ↔ SRR 캐릭터. 개척자는 SRR에서 이름이 "{NICKNAME}"이므로 운명의 길·속성으로 찾는다. */
export function findSrrCharacter(c: Pick<CharacterData, 'name' | 'path' | 'element'>, srr: SrrData): any | null {
  const samePE = (x: any) => (!c.path || x.path === c.path) && (!c.element || x.element === c.element);
  const byName = pickMatch(srr.byCharName.get(normName(c.name)), samePE);
  if (byName) return byName;
  // 위키는 같은 이름의 캐릭터를 "이름•운명의 길"로 구분한다(예: "Mar. 7th•수렵"). SRR은 둘 다 "Mar. 7th"이므로 접미사를 떼고 길·속성이 모두 같은 것만 인정한다.
  const stem = c.name.split(/\s*[•·ㆍ・]\s*/)[0]?.trim();
  if (stem && stem !== c.name.trim() && !/^개척자/.test(stem)) {
    const exact = (srr.byCharName.get(normName(stem)) ?? []).filter(samePE);
    if (exact.length === 1) return exact[0];
  }
  if (/^개척자/.test(c.name.trim())) {
    const tb = Object.values<any>(srr.chars).filter((x) => /NICKNAME/.test(String(x.name)) && samePE(x));
    if (tb.length) return tb.sort((a, b) => Number(a.id) - Number(b.id))[0];
  }
  // 마지막 수단: 길·속성이 모두 같은 캐릭터 중 이름이 거의 같은 하나(번역 표기 차이)
  const stem2 = c.name.split(/\s*[•·ㆍ・]\s*/)[0]?.trim() || c.name;
  return fuzzyBest(stem2, Object.values<any>(srr.chars).filter((x) => !/NICKNAME/.test(String(x.name)) && (c.path ? x.path === c.path : true) && (c.element ? x.element === c.element : true)));
}

// ───────── 작은 행적 (SRR 노드) ─────────

const TYPE_TO_STAT: Record<string, { stat: string; unit: 'pct' | 'flat'; element?: string }> = {
  AttackAddedRatio: { stat: 'atk', unit: 'pct' },
  DefenceAddedRatio: { stat: 'def', unit: 'pct' },
  HPAddedRatio: { stat: 'hp', unit: 'pct' },
  SpeedDelta: { stat: 'spd', unit: 'flat' },
  CriticalChanceBase: { stat: 'crit_rate', unit: 'pct' },
  CriticalDamageBase: { stat: 'crit_dmg', unit: 'pct' },
  StatusProbabilityBase: { stat: 'effect_hit', unit: 'pct' },
  StatusResistanceBase: { stat: 'effect_res', unit: 'pct' },
  BreakDamageAddedRatioBase: { stat: 'break_effect', unit: 'pct' },
  HealRatioBase: { stat: 'outgoing_healing', unit: 'pct' },
  ElationDamageAddedRatioBase: { stat: 'elation', unit: 'pct' },
  PhysicalAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Physical' },
  FireAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Fire' },
  IceAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Ice' },
  ThunderAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Thunder' },
  WindAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Wind' },
  QuantumAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Quantum' },
  ImaginaryAddedRatio: { stat: 'elemental_dmg', unit: 'pct', element: 'Imaginary' },
};

/** SRR의 작은 행적(속성 보너스) 노드 → MinorTrace[]. 노드 id는 `${캐릭터id}${3자리}`이며 효과(properties)가 있는 것만 해당 */
export function srrMinorTraces(trees: Record<string, any>, charId: string): MinorTrace[] {
  const out: MinorTrace[] = [];
  const nodes = Object.values<any>(trees)
    .filter((n) => String(n.id).startsWith(charId) && String(n.id).length === charId.length + 3)
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const n of nodes) {
    const lv = n.levels?.[(n.levels?.length ?? 1) - 1];
    for (const p of lv?.properties ?? []) {
      const m = TYPE_TO_STAT[p.type];
      if (!m) continue;
      const value = m.unit === 'flat' ? Number(p.value) : r2(Number(p.value) * 100, 3);
      out.push({ key: String(n.anchor ?? n.id), title: String(n.name ?? ''), stat: m.stat as any, value, unit: m.unit, element: m.element as any });
    }
  }
  return out;
}

function totalsClose(a: CharacterData['minor_traces']['totals'], b: CharacterData['minor_traces']['totals']): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? {};
    const bv = b[k] ?? {};
    if (Math.abs((av.pct ?? 0) - (bv.pct ?? 0)) > 0.35) diffs.push(`${k} %: 위키 ${av.pct ?? 0} / SRR ${bv.pct ?? 0}`);
    if (Math.abs((av.flat ?? 0) - (bv.flat ?? 0)) > 0.01) diffs.push(`${k} 고정값: 위키 ${av.flat ?? 0} / SRR ${bv.flat ?? 0}`);
    if (av.element && bv.element && av.element !== bv.element) diffs.push(`${k} 속성: 위키 ${av.element} / SRR ${bv.element}`);
  }
  return diffs;
}

/** 위키에서 작은 행적을 다 읽지 못했거나 SRR과 값이 다르면 SRR 값을 쓴다. 일치하면 검증 표시만 남긴다. */
export function reconcileMinorTraces(c: CharacterData, srr: SrrData, hit: any): void {
  if (!srr.trees) return;
  const items = srrMinorTraces(srr.trees, String(hit.id));
  const wikiComplete = c.minor_traces.count === 10 && c.minor_traces.unparsed.length === 0;
  if (items.length !== 10) {
    if (!wikiComplete) c.warnings.push(`작은 행적을 위키에서 다 읽지 못했지만 StarRailRes에도 10개가 없어(${items.length}개) 보완하지 못했습니다.`);
    return;
  }
  const srrTotals = sumMinor(items);
  const diffs = wikiComplete ? totalsClose(c.minor_traces.totals, srrTotals) : ['위키 값 누락/미분류'];
  if (wikiComplete && diffs.length === 0) {
    c.minor_traces.source = 'wiki + StarRailRes 일치 확인';
    return;
  }
  c.warnings.push(`작은 행적: 위키 값을 StarRailRes 값으로 대체했습니다(사유: ${diffs.join('; ')}).`);
  c.minor_traces = { count: 10, items, totals: srrTotals, unparsed: [], source: 'StarRailRes(위키 값 누락/불일치 보완)' };
}

// ───────── 성혼의 스킬 레벨 보너스 (SRR level_up_skills) ─────────

const SKILL_TYPE_KIND: Record<string, SkillKind> = {
  Normal: 'basic',
  BPSkill: 'skill',
  Ultra: 'ultimate',
  Talent: 'talent',
  ElationDamage: 'elation_skill',
  MemospriteSkill: 'memosprite_skill',
  MemospriteTalent: 'memosprite_talent',
};
const PASSIVE_KINDS = new Set<SkillKind>(['talent', 'memosprite_talent']);

type LevelBonus = Partial<Record<SkillKind, number>>;

/**
 * StarRailRes의 성혼별 level_up_skills → 성혼 순번(1~6)별 스킬 종류 레벨 보너스(그 순번에서 새로 오르는 양).
 *  - 한 스킬이 강화판·변형 등 여러 id로 쪼개져 있어도 한 번만 오른 것으로 센다 → 종류별로 id마다 누적한 값의 최댓값
 *  - 같은 순번에서 특성 id와 "같은 이름"의 능동 스킬 id가 함께 오르면 그 능동 id는 특성이 발동하는 연계 스킬이다(레벨이 특성을 따라감)
 *    → 제외한다. (카스토리스 E3: 기억 정령 특성 "묘지를 불사르는 어둠의 날개"와 이름이 같은 기억 정령 '스킬' id)
 * 필요한 데이터가 없으면 null.
 */
export function srrLevelBonuses(srr: SrrData, hit: { ranks?: (string | number)[] }): LevelBonus[] | null {
  if (!srr.ranks || !srr.skills || !Array.isArray(hit.ranks) || hit.ranks.length < 6) return null;
  const perId = new Map<SkillKind, Map<string, number>>();
  const out: LevelBonus[] = [];
  let prev: LevelBonus = {};
  for (let i = 0; i < 6; i++) {
    const rank = srr.ranks[String(hit.ranks[i])];
    if (!rank) return null;
    const ups = (rank.level_up_skills ?? [])
      .map((u) => ({ id: String(u.id), num: Number(u.num) || 0, sk: srr.skills![String(u.id)] }))
      .filter((u) => u.sk && SKILL_TYPE_KIND[u.sk.type]);
    const passiveNames = new Set(ups.filter((u) => PASSIVE_KINDS.has(SKILL_TYPE_KIND[u.sk.type])).map((u) => u.sk.name));
    for (const u of ups) {
      const kind = SKILL_TYPE_KIND[u.sk.type];
      if (!PASSIVE_KINDS.has(kind) && passiveNames.has(u.sk.name)) continue;
      const m = perId.get(kind) ?? perId.set(kind, new Map()).get(kind)!;
      m.set(u.id, (m.get(u.id) ?? 0) + u.num);
    }
    const cum: LevelBonus = {};
    for (const [k, m] of perId) cum[k] = Math.max(...m.values());
    const delta: LevelBonus = {};
    for (const k of Object.keys(cum) as SkillKind[]) {
      const d = (cum[k] ?? 0) - (prev[k] ?? 0);
      if (d > 0) delta[k] = d;
    }
    out.push(delta);
    prev = cum;
  }
  return out;
}

/** 순번 1..upTo까지 누적한 보너스(종류별 합계 상한 적용) */
function cumulativeBonus(per: LevelBonus[], upTo: number): LevelBonus {
  const acc: LevelBonus = {};
  for (let i = 0; i < upTo; i++) for (const [k, v] of Object.entries(per[i] ?? {}) as [SkillKind, number][]) acc[k] = (acc[k] ?? 0) + v;
  for (const k of Object.keys(acc) as SkillKind[]) acc[k] = Math.min(acc[k]!, BONUS_TOTAL_CAP[k] ?? acc[k]!);
  return acc;
}

/**
 * 성혼 스킬 레벨 보너스를 위키 설명과 게임 데이터(StarRailRes)로 대조한다.
 * 위키 문구에는 오기가 있다(효광 E3 "스킬 레벨+1"은 환락 스킬, 에버나이트 E5 "기억 정령 특성"은 정령 스킬).
 * 하나라도 다르면 게임 데이터 값으로 바꾸고, 스킬 레벨을 다시 계산한다.
 */
export function reconcileLevelBonuses(c: CharacterData, srr: SrrData, hit: any): void {
  const srrPer = srrLevelBonuses(srr, hit);
  if (!srrPer) return;
  const wikiPer = c.eidolons.map((e) => e.level_bonus);
  const diffs: string[] = [];
  const last: Partial<Record<SkillKind, number>> = {};
  for (let r = 1; r <= Math.min(wikiPer.length, 6); r++) {
    const w = cumulativeBonus(wikiPer, r);
    const s = cumulativeBonus(srrPer, r);
    for (const k of new Set([...Object.keys(w), ...Object.keys(s)]) as Set<SkillKind>) {
      const a = w[k] ?? 0;
      const b = s[k] ?? 0;
      const d = b - a;
      if (d !== (last[k] ?? 0)) diffs.push(`E${r} ${SKILL_KIND_KO[k] ?? k}: 위키 누적 +${a} / 게임 데이터 +${b}`);
      last[k] = d;
    }
  }
  if (!diffs.length) {
    c.eidolon_level_bonus_source = 'wiki + StarRailRes 일치 확인';
    return;
  }
  c.warnings.push(`성혼 스킬 레벨 보너스: 위키 설명이 게임 데이터(StarRailRes)와 달라 게임 데이터 값을 썼습니다(${diffs.join('; ')}).`);
  c.eidolons.forEach((e, i) => {
    if (i < 6) e.level_bonus = { ...srrPer[i] };
  });
  c.eidolon_level_bonus_source = 'StarRailRes(위키 설명 불일치 보정)';
  recomputeSkillLevels(c);
}

// ───────── 캐릭터 / 광추 ─────────

export function enrichCharacter(c: CharacterData, srr: SrrData | null): void {
  if (!srr) {
    c.warnings.push('StarRailRes 보강 데이터를 불러오지 못해 위키의 정수 내림 기초 능력치를 사용합니다(±1~3 오차).');
    return;
  }
  const hit = findSrrCharacter(c, srr);
  if (!hit) {
    c.warnings.push('StarRailRes에서 같은 캐릭터를 찾지 못해 위키 정수값을 사용합니다.');
    return;
  }
  const promo = srr.promos[String(hit.id)]?.values?.[6];
  if (promo) {
    const b = c.base_stats_lv80;
    b.hp = r2(lv80(promo.hp)!, 3);
    b.atk = r2(lv80(promo.atk)!, 3);
    b.def = r2(lv80(promo.def)!, 3);
    if (promo.spd) b.spd = r2(lv80(promo.spd)!, 3);
    if (promo.taunt) b.taunt = promo.taunt.base;
    if (typeof hit.max_sp === 'number') {
      b.energy_cost = hit.max_sp;
      const wikiCost = c.skills.find((s) => s.kind === 'ultimate')?.energy;
      if (wikiCost != null && wikiCost !== hit.max_sp) {
        c.warnings.push(`필살기 에너지: 위키 스킬 설명은 ${wikiCost}, StarRailRes는 ${hit.max_sp}로 서로 다릅니다. energy_cost는 StarRailRes 값(${hit.max_sp})이며, 사이클 계산에는 어느 쪽을 썼는지 밝히고 확인 필요로 표시하세요.`);
      }
    }
    b.source = 'StarRailRes(소수점 포함) + 위키';
  }
  reconcileMinorTraces(c, srr, hit);
  reconcileLevelBonuses(c, srr, hit);
}

/** 위키 광추 ↔ SRR 광추. 이름이 다르면(번역 표기 차이) 같은 운명의 길·희귀도 안에서 유사 이름 하나만 인정한다. */
export function findSrrLightCone(lc: Pick<LightConeData, 'name' | 'path' | 'rarity'>, srr: SrrData): { hit: any; fuzzy: boolean } | null {
  const sameClass = (x: any) => (!lc.path || x.path === lc.path) && (!lc.rarity || x.rarity === lc.rarity);
  const exact = pickMatch(srr.byLcName.get(normName(lc.name)), sameClass);
  if (exact) return { hit: exact, fuzzy: false };
  const fz = fuzzyBest(lc.name, Object.values<any>(srr.lcs).filter(sameClass));
  return fz ? { hit: fz, fuzzy: true } : null;
}

export function enrichLightCone(lc: LightConeData, srr: SrrData | null): void {
  if (!srr) return;
  const found = findSrrLightCone(lc, srr);
  if (!found) return;
  const hit = found.hit;
  if (found.fuzzy) (lc.notes ??= []).push(`StarRailRes의 "${hit.name}"과 이름 표기가 달라 유사 이름으로 매칭해 기초 능력치를 보정했습니다.`);
  const promo = srr.lcPromos[String(hit.id)]?.values?.[6];
  if (!promo) return;
  lc.base_stats_lv80 = {
    hp: r2(lv80(promo.hp)!, 3),
    atk: r2(lv80(promo.atk)!, 3),
    def: r2(lv80(promo.def)!, 3),
    source: 'StarRailRes(소수점 포함)',
  };
}
