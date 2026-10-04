// MCP 툴 정의 (Vercel 라우트와 로컬 테스트 하니스가 공유)

import { z } from 'zod';
import { accessKey } from './access';
import { WikiClient, MENU, ListItem, fv } from './wiki';
import { SrrClient, SrrData, enrichCharacter, enrichLightCone, findSrrCharacter } from './enrich';
import { CharacterData, normalizeCharacter, presentCharacter } from './character';
import { RelicSetData, normalizeLightCone, normalizeRelicSet, lcBaseFromEntry, lcBaseIncomplete } from './lightcone';
import { Candidate, pickBest, rankMatches, resolveParty, ResolvedMember } from './notation';
import { signatureFor, signatureOwners, noSignatureReason, SIGNATURE_BUILT, derivedSignatureList } from './signature';
import { BASELINE, ensureDerivedSignatures, runSync } from './sync';
import { calcBuild, Modifier } from './calc';
import { planRelics } from './planner';
import { simulateTurns } from './turns';
import { MAIN_KO, MAIN_OPTIONS, MAIN_VALUE, RELIC_RULES, SLOTS, SLOT_KO, SUB_KEYS, SUB_KO, SUB_ROLL, subRollValue } from './relicdata';
import { PATH_FROM_KO, PATH_KO, ELEMENT_KO } from './stats';
import { normName, r2 } from './util';

export interface Services {
  wiki: WikiClient;
  srr: SrrClient;
}

let shared: Services | null = null;
export function services(): Services {
  if (!shared) shared = { wiki: new WikiClient(), srr: new SrrClient() };
  return shared;
}
export function setServices(s: Services) {
  shared = s;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<any>;
  run: (args: any, svc: Services) => Promise<any>;
}

const KIND = z.enum(['character', 'light_cone', 'relic']);
type Kind = z.infer<typeof KIND>;
const MENU_OF: Record<Kind, '104' | '107' | '108'> = { character: MENU.character, light_cone: MENU.light_cone, relic: MENU.relic };

async function findItem(svc: Services, kind: Kind, q: string): Promise<{ item: ListItem; ambiguous?: Candidate[] }> {
  let list = await svc.wiki.listAll(MENU_OF[kind]);
  const key = String(q).trim();
  const attempt = (l: ListItem[]): { item: ListItem; ambiguous?: Candidate[] } | null => {
    if (/^\d+$/.test(key)) {
      const hit = l.find((i) => String(i.entry_page_id) === key);
      if (hit) return { item: hit };
    }
    const items = l.map((i) => ({ id: String(i.entry_page_id), name: i.name }));
    const cands = rankMatches(key, items, 6);
    const { best, ambiguous } = pickBest(cands);
    if (!best) return null;
    return { item: l.find((i) => String(i.entry_page_id) === best.id)!, ambiguous: ambiguous ? cands : undefined };
  };
  let found = attempt(list);
  if (!found) {
    // 위키에 새로 추가된 항목일 수 있으니 목록을 새로 읽어 한 번 더 찾는다(같은 메뉴는 5분에 한 번만 실제 갱신)
    const fresh = await svc.wiki.refreshList(MENU_OF[kind]);
    if (fresh !== list) {
      list = fresh;
      found = attempt(list);
    }
  }
  if (!found) {
    const items = list.map((i) => ({ id: String(i.entry_page_id), name: i.name }));
    const near = rankMatches(key.slice(0, 2), items, 5).map((c) => c.name).join(', ');
    throw new Error(`"${q}"에 해당하는 항목을 찾지 못했습니다.${near ? ` 비슷한 이름: ${near}` : ''}`);
  }
  return found;
}

function brief(kind: Kind, it: ListItem) {
  if (kind === 'character') {
    const pk = fv(it, 'character_paths')[0] ?? null;
    return {
      kind,
      id: String(it.entry_page_id),
      name: it.name.trim(),
      rarity: Number((fv(it, 'character_rarity')[0] ?? '').replace('★', '')) || null,
      element_ko: fv(it, 'character_combat_type')[0] ?? null,
      path_ko: pk,
    };
  }
  if (kind === 'light_cone') {
    return {
      kind,
      id: String(it.entry_page_id),
      name: it.name.trim(),
      rarity: Number((fv(it, 'equipment_rarity')[0] ?? '').replace('★', '')) || null,
      path_ko: fv(it, 'equipment_paths')[0] ?? null,
      source: fv(it, 'equipment_source')[0] ?? null,
    };
  }
  const rs = normalizeRelicSet(it);
  return { kind, id: rs.id, name: rs.name.trim(), type: rs.type };
}

// ───────── 캐릭터 가공 ─────────

function minorTraceModifiers(c: CharacterData): Modifier[] {
  const out: Modifier[] = [];
  for (const [stat, v] of Object.entries(c.minor_traces.totals)) {
    if (v.pct) out.push({ stat, value: v.pct, unit: 'pct', group: 'minor_traces', label: `작은 행적 합계(${c.minor_traces.count}개 전부 활성)` });
    if (v.flat) out.push({ stat, value: v.flat, unit: 'flat', group: 'minor_traces', label: `작은 행적 합계(${c.minor_traces.count}개 전부 활성)` });
  }
  return out;
}

/** 힌트에서 원문 문장(sentence)을 뺀다 — 같은 문장이 text에 이미 있고, 한 문장에서 나온 힌트마다 되풀이돼 응답만 커진다 */
const slimHints = (hints: any[] | undefined, slim: boolean) => (slim && hints ? hints.map(({ sentence, ...rest }: any) => rest) : hints);

function shapeCharacter(c: CharacterData, eidolon: number, includeLevels: boolean, slim = false) {
  const shaped = presentCharacter(c, includeLevels);
  shaped.eidolon_selected = eidolon;
  shaped.eidolons = c.eidolons.map((e) =>
    e.rank <= eidolon
      ? { rank: e.rank, name: e.name, unlocked: true, text: e.text, level_bonus: e.level_bonus, stat_hints: slimHints(e.hints, slim) }
      : { rank: e.rank, name: e.name, unlocked: false },
  );
  shaped.minor_traces = {
    note: '작은 행적은 전부 활성화한 것으로 합산',
    count: c.minor_traces.count,
    totals: c.minor_traces.totals,
    items: c.minor_traces.items.map((t) => `${t.title}: ${t.stat}${t.element ? '(' + t.element + ')' : ''} +${t.value}${t.unit === 'pct' ? '%' : ''}`),
    unparsed: c.minor_traces.unparsed.length ? c.minor_traces.unparsed : undefined,
  };
  shaped.major_traces = c.major_traces.map((m) => ({ key: m.key, title: m.title, text: m.text, stat_hints: slimHints(m.hints, slim) }));
  return shaped;
}

/** StarRailRes에 아직 없는 새 캐릭터면 (30분 한도로) 다시 읽어 본다 */
async function srrForCharacter(svc: Services, c: CharacterData): Promise<SrrData | null> {
  let srr = await svc.srr.load();
  if (srr && !c.incomplete && !findSrrCharacter(c, srr)) srr = await svc.srr.refresh();
  return srr;
}

async function loadCharacter(svc: Services, q: string, eidolon: number, enrich: boolean) {
  await ensureDerivedSignatures(svc.wiki);
  const { item, ambiguous } = await findItem(svc, 'character', q);
  const page = await svc.wiki.getEntry(item.entry_page_id);
  const c = normalizeCharacter(page, item, { eidolon });
  if (enrich) enrichCharacter(c, await srrForCharacter(svc, c));
  return { c, item, ambiguous };
}

async function loadLightCone(svc: Services, q: string, s: number, enrich: boolean) {
  await ensureDerivedSignatures(svc.wiki);
  const { item, ambiguous } = await findItem(svc, 'light_cone', q);
  const lc = normalizeLightCone(item, s);
  if (lcBaseIncomplete(lc)) {
    try {
      const page = await svc.wiki.getEntry(item.entry_page_id);
      const b = lcBaseFromEntry(page);
      if (b && b.hp != null && b.atk != null && b.def != null) lc.base_stats_lv80 = { ...b, source: 'wiki 상세(정수 내림값)' };
    } catch {
      /* 무시 */
    }
  }
  if (enrich) enrichLightCone(lc, await svc.srr.load());
  const owners = signatureOwners(lc.id);
  if (owners.length) lc.signature_of = owners.map((o) => o.name);
  return { lc, item, ambiguous };
}

function lcForOutput(lc: ReturnType<typeof normalizeLightCone>) {
  return {
    id: lc.id,
    name: lc.name,
    rarity: lc.rarity,
    path: lc.path,
    path_ko: lc.path_ko,
    source: lc.source,
    signature_of: lc.signature_of,
    superimposition: lc.superimposition,
    passive_name: lc.passive_name,
    passive_text: lc.passive_text,
    base_stats_lv80: lc.base_stats_lv80,
    stat_hints: lc.stat_hints,
    notes: lc.notes,
  };
}

// ───────── 툴 목록 ─────────

const eidolonSchema = z.number().int().min(0).max(6);
const supSchema = z.number().int().min(1).max(5);

// 입력 스키마는 strict: 모델이 슬롯 이름(boots 등)이나 필드 이름을 잘못 써도 조용히 버려지지 않고 오류로 알려 주도록 한다.
const scaleSchema = z
  .object({
    from: z.string().describe("기준 최종 스탯 키 (예: 'def')"),
    threshold: z.number().optional(),
    step: z.number().optional(),
    per: z.number().optional(),
    base: z.number().optional(),
    cap_over: z.number().optional(),
    floor: z.boolean().optional(),
  })
  .strict();

const modifierSchema = z
  .object({
    stat: z.string().describe("스탯 키: hp, atk, def, spd, crit_rate, crit_dmg, break_effect, effect_hit, effect_res, energy_regen, outgoing_healing, elemental_dmg, elation 또는 임의 키. 공격력 %는 stat='atk', unit='pct' (atk_pct 아님)"),
    value: z.number().optional().describe('증가량. hp/atk/def/spd는 unit=pct면 기초치 대비 %, unit=flat이면 고정값. 나머지 스탯은 %p'),
    unit: z.enum(['pct', 'flat']).optional().describe("기본 'pct'"),
    group: z.string().optional().describe('출처 그룹: minor_traces, major_traces, eidolon, lc_passive, relic_set, team_buff, other (relic_main/relic_sub는 유물 입력에서 자동 생성)'),
    label: z.string().optional(),
    scale: scaleSchema.optional().describe('다른 최종 스탯에 비례하는 보너스: threshold 이상이면 base + per × floor((from-threshold, 상한 cap_over)/step)'),
  })
  .strict();

const baseSchema = z
  .object({ hp: z.number(), atk: z.number(), def: z.number(), spd: z.number() })
  .catchall(z.number())
  .describe('캐릭터 Lv.80 기초 능력치(hsr_prepare_party의 calc_seed.base 그대로). crit_rate=5, crit_dmg=50, energy_regen=100은 기본값');

const lcBaseSchema = z.object({ hp: z.number().optional(), atk: z.number().optional(), def: z.number().optional() }).nullable().optional();

const relicPieceSchema = z
  .object({
    main: z.string().describe('주옵션 키 (hsr_relic_rules 참고)'),
    subs: z.record(z.string(), z.number()).optional().describe('부옵션 키 → 롤 횟수'),
    start: z.union([z.literal(3), z.literal(4)]).optional().describe('초기 부옵션 수 (4면 총 9롤, 3이면 8롤)'),
    quality: z.enum(['low', 'avg', 'high']).optional(),
  })
  .strict();

const targetSchema = z
  .object({
    stat: z.string(),
    min: z.number().optional().describe('최종 스탯 하한(반드시 충족)'),
    max: z.number().optional().describe('최종 스탯 상한(넘으면 안 되는 값. 플래너는 이 안에 들도록 배분하며, 불가능하면 overshoots로 알린다). min보다 롤 한 번의 크기(속도 2.3 등) 이상 넓게 잡는다'),
    label: z.string().optional(),
  })
  .strict();

/** 부위 키: head(머리) hands(손) body(몸통) feet(발) sphere(연결 구체) rope(연결 줄) */
const slotMap = <T extends z.ZodTypeAny>(t: T) =>
  z.object(Object.fromEntries(SLOTS.map((s) => [s, t.optional()])) as Record<(typeof SLOTS)[number], z.ZodOptional<T>>).strict();

/** 파티 표기 해석. 캐릭터/광추를 못 찾으면(위키에 새로 추가됐을 수 있음) 목록을 새로 읽어 한 번 더 시도한다. */
async function resolveWithRefresh(svc: Services, text: string) {
  await ensureDerivedSignatures(svc.wiki);
  let [characters, lightCones] = await Promise.all([svc.wiki.listAll(MENU.character), svc.wiki.listAll(MENU.light_cone)]);
  let r = resolveParty(text, { characters, lightCones });
  const missing = r.members.some((m) => !m.character) || r.warnings.some((w) => /광추를 찾지 못함/.test(w));
  if (missing) {
    const [c2, l2] = await Promise.all([svc.wiki.refreshList(MENU.character), svc.wiki.refreshList(MENU.light_cone)]);
    if (c2 !== characters || l2 !== lightCones) {
      characters = c2;
      lightCones = l2;
      await ensureDerivedSignatures(svc.wiki, 0);
      r = resolveParty(text, { characters, lightCones });
    }
  }
  return { ...r, characters, lightCones };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'hsr_search',
    title: '붕괴: 스타레일 위키 검색',
    description: '캐릭터·광추·유물 세트를 이름(한국어, 약칭 가능)으로 검색해 위키 ID를 돌려준다.',
    input: z.object({
      query: z.string().describe('검색어(예: 펄, 은랑 LV.999, 슈룸 모험기)'),
      kind: z.enum(['character', 'light_cone', 'relic', 'all']).optional().describe("기본 'all'"),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    run: async ({ query, kind = 'all', limit = 8 }, svc) => {
      const kinds: Kind[] = kind === 'all' ? ['character', 'light_cone', 'relic'] : [kind];
      const out: any[] = [];
      for (const k of kinds) {
        const list = await svc.wiki.listAll(MENU_OF[k]);
        const cands = rankMatches(query, list.map((i) => ({ id: String(i.entry_page_id), name: i.name })), limit);
        for (const c of cands) out.push({ ...brief(k, list.find((i) => String(i.entry_page_id) === c.id)!), score: c.score });
      }
      out.sort((a, b) => b.score - a.score);
      return { query, results: out.slice(0, limit) };
    },
  },
  {
    name: 'hsr_get_character',
    title: '캐릭터 상세(스펙·행적·스킬·성혼)',
    description:
      '위키에서 캐릭터 한 명의 Lv.80 기초 능력치, 작은 행적(전부 활성 합계), 큰 행적(추가 능력), 스킬 설명과 스킬 레벨별 수치(성혼 보너스 반영 레벨), 성혼 효과를 정규화해 돌려준다. 가능하면 StarRailRes로 소수점 기초치·에너지 비용을 보강한다.',
    input: z.object({
      name_or_id: z.string().describe('캐릭터 이름 또는 위키 ID'),
      eidolon: eidolonSchema.optional().describe('개방한 성혼 수 0~6 (기본 0). 풀돌=6'),
      include_levels: z.boolean().optional().describe('스킬 레벨 1~N 전체 수치표 포함'),
      enrich: z.boolean().optional().describe('StarRailRes 보강 사용(기본 true)'),
    }),
    run: async ({ name_or_id, eidolon = 0, include_levels = false, enrich = true }, svc) => {
      const { c, ambiguous } = await loadCharacter(svc, name_or_id, eidolon, enrich);
      if (c.incomplete) return { id: c.id, name: c.name, incomplete: true, message: '위키에 이 항목의 행적·능력치가 아직 입력되지 않았습니다(미공개/미완성 항목).', warnings: c.warnings };
      const sig = signatureFor(c.id);
      return {
        ambiguous_matches: ambiguous,
        ...shapeCharacter(c, eidolon, include_levels),
        signature_light_cones: sig,
        signature_note: sig ? undefined : noSignatureReason(c.id) ?? '전용 광추 정보 없음(4성이거나 매핑 누락)',
      };
    },
  },
  {
    name: 'hsr_get_light_cone',
    title: '광추 상세(중첩 단계 반영)',
    description: '광추의 Lv.80 기초 능력치와 패시브 효과를 지정한 중첩(재련) 단계 수치로 렌더링해 돌려준다. 패시브의 스탯 증가 문장 후보(stat_hints)도 함께 제공한다.',
    input: z.object({
      name_or_id: z.string(),
      superimposition: supSchema.optional().describe('중첩 1~5 (기본 1, 풀재=5)'),
      enrich: z.boolean().optional(),
    }),
    run: async ({ name_or_id, superimposition = 1, enrich = true }, svc) => {
      const { lc, ambiguous } = await loadLightCone(svc, name_or_id, superimposition, enrich);
      return { ambiguous_matches: ambiguous, ...lcForOutput(lc) };
    },
  },
  {
    name: 'hsr_list_light_cones',
    title: '광추 목록(필터)',
    description: '운명의 길·희귀도·이름으로 광추를 필터링해 나열한다. 전용이 아닌 광추를 고를 때 후보 조회용.',
    input: z.object({
      path: z.string().optional().describe('운명의 길(한국어: 파멸/수렵/지식/화합/공허/보존/풍요/기억/환락 또는 영문)'),
      rarity: z.number().int().min(3).max(5).optional(),
      query: z.string().optional(),
      superimposition: supSchema.optional(),
      full_text: z.boolean().optional().describe('패시브 전문 포함(기본은 180자 요약)'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: async ({ path, rarity, query, superimposition = 1, full_text = false, limit = 40 }, svc) => {
      await ensureDerivedSignatures(svc.wiki);
      const list = await svc.wiki.listAll(MENU.light_cone);
      const pathKo = path ? (PATH_KO[path] ?? (PATH_FROM_KO[path] ? path : path)) : null;
      const q = query ? normName(query) : null;
      const out = [];
      for (const it of list) {
        const lc = normalizeLightCone(it, superimposition);
        if (pathKo && lc.path_ko !== pathKo) continue;
        if (rarity && lc.rarity !== rarity) continue;
        if (q && !normName(lc.name).includes(q)) continue;
        out.push({
          id: lc.id,
          name: lc.name.trim(),
          rarity: lc.rarity,
          path_ko: lc.path_ko,
          source: lc.source,
          signature_of: signatureOwners(lc.id).map((o) => o.name),
          passive_name: lc.passive_name,
          passive: full_text ? lc.passive_text : lc.passive_text.length > 180 ? lc.passive_text.slice(0, 177) + '…' : lc.passive_text,
        });
        if (out.length >= limit) break;
      }
      return { count: out.length, light_cones: out };
    },
  },
  {
    name: 'hsr_list_relic_sets',
    title: '유물 세트 목록',
    description: '동굴 유물(4세트)과 차원 장신구(2세트)의 2/4세트 효과를 나열한다. query로 이름·효과 키워드를 필터링.',
    input: z.object({
      type: z.enum(['cavern', 'planar', 'all']).optional(),
      query: z.string().optional().describe('이름 또는 효과 문구에 포함된 키워드'),
      include_hints: z.boolean().optional().describe('스탯 증가 문장 후보 포함'),
      limit: z.number().int().min(1).max(80).optional(),
    }),
    run: async ({ type = 'all', query, include_hints = false, limit = 60 }, svc) => {
      const list = await svc.wiki.listAll(MENU.relic);
      const q = query ? normName(query) : null;
      const out: any[] = [];
      for (const it of list) {
        const rs = normalizeRelicSet(it);
        if (type !== 'all' && rs.type !== type) continue;
        if (q && !normName(`${rs.name}${rs.two_piece}${rs.four_piece ?? ''}`).includes(q)) continue;
        out.push(include_hints ? rs : stripHints(rs));
        if (out.length >= limit) break;
      }
      return { count: out.length, sets: out };
    },
  },
  {
    name: 'hsr_get_relic_set',
    title: '유물 세트 상세',
    description: '유물 세트 한 개의 2/4세트 효과와 스탯 증가 문장 후보를 돌려준다.',
    input: z.object({ name_or_id: z.string() }),
    run: async ({ name_or_id }, svc) => {
      const { item, ambiguous } = await findItem(svc, 'relic', name_or_id);
      return { ambiguous_matches: ambiguous, ...normalizeRelicSet(item) };
    },
  },
  {
    name: 'hsr_parse_party',
    title: '파티 표기 해석',
    description:
      '“은랑Lv.999(풀돌풀재), 에바네시아(1돌전광), 펄(1돌,슈룸모험기)” 같은 표기를 캐릭터·성혼·광추·중첩 단계로 해석한다(Lv.999는 은랑 LV.999 캐릭터 이름의 일부). 가정(assumptions)과 모호한 항목을 알려준다.',
    input: z.object({ text: z.string().describe('파티 표기 원문') }),
    run: async ({ text }, svc) => {
      const { members, warnings } = await resolveWithRefresh(svc, text);
      return { signature_map_built: SIGNATURE_BUILT, members, warnings };
    },
  },
  {
    name: 'hsr_prepare_party',
    title: '파티 일괄 준비(표기 해석 + 모든 데이터)',
    description:
      '파티 표기를 해석하고, 멤버별로 캐릭터 상세(성혼 반영), 광추(중첩 반영), 계산기 입력 씨앗(calc_seed: 기초 능력치 + 작은 행적 보너스)을 한 번에 돌려준다. 덱 빌딩의 첫 호출로 사용한다.',
    input: z.object({
      text: z.string().describe('파티 표기 원문'),
      member: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe('1부터 세는 멤버 순번. 지정하면 그 멤버만 돌려준다(클라이언트가 응답 크기를 잘라 버릴 때 멤버별로 나눠 호출)'),
      include_levels: z.boolean().optional().describe('스킬 레벨 전체 수치표 포함(응답이 매우 커짐)'),
      enrich: z.boolean().optional(),
    }),
    run: async ({ text, member, include_levels = false, enrich = true }, svc) => {
      const { members: allMembers, warnings, characters, lightCones } = await resolveWithRefresh(svc, text);
      if (member != null && member > allMembers.length) throw new Error(`member=${member}: 이 파티는 ${allMembers.length}명입니다.`);
      const members = member != null ? [allMembers[member - 1]] : allMembers;
      const out = await Promise.all(
        members.map(async (m: ResolvedMember) => {
          try {
            if (!m.character) return { input: m.raw, notes: m.notes, error: '캐릭터를 찾지 못함' };
            const item = characters.find((i) => String(i.entry_page_id) === m.character!.id)!;
            const page = await svc.wiki.getEntry(item.entry_page_id);
            const c = normalizeCharacter(page, item, { eidolon: m.eidolon });
            if (c.incomplete) return { input: m.raw, notes: m.notes, error: `${c.name}: 위키에 행적·능력치가 아직 입력되지 않은 항목입니다.` };
            const srr = enrich ? await srrForCharacter(svc, c) : null;
            if (enrich) enrichCharacter(c, srr);
            let lcOut: any = null;
            let lcBase: { hp?: number; atk?: number; def?: number } | null = null;
            const lcRef = m.light_cone;
            if (lcRef.id) {
              const lcItem = lightCones.find((i) => String(i.entry_page_id) === lcRef.id)!;
              const lc = normalizeLightCone(lcItem, lcRef.superimposition);
              if (lcBaseIncomplete(lc)) {
                try {
                  const b = lcBaseFromEntry(await svc.wiki.getEntry(lcItem.entry_page_id));
                  if (b && b.hp != null && b.atk != null && b.def != null) lc.base_stats_lv80 = { ...b, source: 'wiki 상세(정수 내림값)' };
                } catch {
                  /* 무시 */
                }
              }
              if (enrich) enrichLightCone(lc, srr);
              const owners = signatureOwners(lc.id);
              if (owners.length) lc.signature_of = owners.map((o) => o.name);
              lcOut = { mode: lcRef.mode, signature_confidence: lcRef.signature_confidence, path_match: lcRef.path_match, ...lcForOutput(lc) };
              lcOut.stat_hints = slimHints(lcOut.stat_hints, true);
              const b = lc.base_stats_lv80;
              lcBase = { hp: b.hp ?? 0, atk: b.atk ?? 0, def: b.def ?? 0 };
            }
            const b = c.base_stats_lv80;
            const calc_seed = {
              name: `${c.name} (E${m.eidolon}${lcOut ? `, ${lcOut.name} S${lcRef.superimposition}` : ', 광추 없음'})`,
              base: { hp: b.hp, atk: b.atk, def: b.def, spd: b.spd, crit_rate: 5, crit_dmg: 50, energy_regen: 100 },
              light_cone: lcBase,
              modifiers: minorTraceModifiers(c),
              energy_cost: b.energy_cost,
              taunt: b.taunt,
              element: c.element,
              path: c.path,
            };
            return {
              input: m.raw,
              notes: m.notes,
              eidolon: m.eidolon,
              character: shapeCharacter(c, m.eidolon, include_levels, true),
              light_cone: lcOut,
              calc_seed,
              signature_light_cones: signatureFor(c.id),
            };
          } catch (e: any) {
            // 한 명의 데이터가 없거나 위키 호출이 실패해도 나머지 멤버는 돌려준다
            return { input: m.raw, notes: m.notes, error: `데이터를 가져오지 못함: ${e?.message ?? String(e)}` };
          }
        }),
      );
      return {
        assumptions: [
          '캐릭터 Lv.80, 광추 Lv.80, 작은 행적 전부 활성, 큰 행적(추가 능력) 전부 개방, 스킬 레벨은 성혼 보너스를 반영한 최대 레벨',
          '성혼 표기가 없으면 0돌, 중첩 표기가 없으면 1재, 광추 표기가 없으면 전용 광추',
          '위키 기초 능력치는 정수 내림값이므로 StarRailRes 보강이 되었을 때만 소수점까지 정확',
        ],
        // 멤버별 경고(위키-게임 데이터 불일치 보정 등)는 놓치기 쉬우므로 맨 위에도 올린다
        warnings: [...warnings, ...out.flatMap((m: any) => (m.character?.warnings ?? []).map((w: string) => `[${m.character.name}] ${w}`))],
        members: out,
      };
    },
  },
  {
    name: 'hsr_relic_rules',
    title: '유물 규칙·상수',
    description: '5성 +15 유물의 부위별 주옵션 후보와 값, 부옵션 1롤 값(하/중/상), 롤 개수 규칙을 돌려준다.',
    input: z.object({}),
    run: async () => ({
      rules: RELIC_RULES,
      slots: SLOTS.map((s) => ({ slot: s, ko: SLOT_KO[s], main_options: MAIN_OPTIONS[s].map((k) => ({ key: k, ko: MAIN_KO[k], value: MAIN_VALUE[k].value, unit: MAIN_VALUE[k].unit })) })),
      substats: SUB_KEYS.map((k) => ({ key: k, ko: SUB_KO[k], unit: SUB_ROLL[k].unit, low: r2(subRollValue(k, 'low'), 3), avg: r2(subRollValue(k, 'avg'), 3), high: r2(subRollValue(k, 'high'), 3) })),
      stat_keys: 'hp, atk, def, spd, crit_rate, crit_dmg, break_effect, effect_hit, effect_res, energy_regen, outgoing_healing, elemental_dmg, elation',
      sub_keys: SUB_KEYS,
    }),
  },
  {
    name: 'hsr_calc_build',
    title: '스탯 합산 계산',
    description:
      '캐릭터 기초·광추 기초에 modifiers(행적·광추·세트·버프)와 유물(부위별 주옵션+부옵션 롤 횟수)을 합산해 최종 스탯과 출처별 기여표(markdown)를 만든다. scale 보너스(예: 방어력에 비례하는 환락도)도 반복 계산으로 해결한다. targets로 임계값 충족 여부를 점검.',
    input: z.object({
      name: z.string().optional(),
      base: baseSchema,
      light_cone: lcBaseSchema,
      base_extra: z.record(z.string(), z.number()).optional(),
      modifiers: z.array(modifierSchema).optional(),
      relics: slotMap(relicPieceSchema).optional(),
      quality: z.enum(['low', 'avg', 'high']).optional().describe("부옵션 롤 품질 (기본 'avg' = 중간값)"),
      targets: z.array(targetSchema).optional(),
    }),
    run: async (args) => calcBuild(args as any),
  },
  {
    name: 'hsr_plan_relics',
    title: '유물 부옵션 롤 배분 계획',
    description:
      '부위별 주옵션과 targets(최종 스탯 하한/상한)를 만족하면서 weights 또는 dps 목적함수를 최대화하는 부옵션 롤 배분(부위 6개 × 부옵션 롤 횟수)을 찾고, calc로 검증한 최종 스탯표까지 돌려준다. 이상적 풀옵션이 아니라 평균 롤 기준의 현실적 최선안을 구한다.',
    input: z.object({
      name: z.string().optional(),
      base: baseSchema,
      light_cone: lcBaseSchema,
      base_extra: z.record(z.string(), z.number()).optional(),
      modifiers: z.array(modifierSchema).optional().describe('유물 부옵션을 제외한 모든 보너스(세트 효과 포함)'),
      main: slotMap(z.string()).describe('부위별 주옵션 키. head/hands는 생략 시 hp/atk'),
      start: z.union([z.literal(3), z.literal(4), slotMap(z.union([z.literal(3), z.literal(4)]))]).optional(),
      quality: z.enum(['low', 'avg', 'high']).optional(),
      targets: z.array(targetSchema).optional(),
      weights: z.record(z.string(), z.number()).optional().describe('부옵션 키 → 1회 평균 롤의 상대 가치(예: crit_rate 1, crit_dmg 1, atk_pct 0.7, spd 0.9)'),
      objective: z.object({ type: z.enum(['weights', 'dps']), stat: z.enum(['atk', 'hp', 'def']).optional() }).optional().describe("dps: 기준스탯 × (1 + 치확×치피) 최대화"),
      forbid: slotMap(z.array(z.string())).optional().describe('부위별로 붙으면 안 되는 부옵션'),
      seed: z.number().int().optional(),
      effort: z.number().int().min(1).max(6).optional(),
    }),
    run: async (args) => planRelics(args as any),
  },
  {
    name: 'hsr_simulate_turns',
    title: '행동 수치(AV) 타임라인 시뮬레이션',
    description:
      '유닛별 속도로 행동 순서를 시뮬레이션한다. events로 행동 앞당김/지연/속도 증감을 지정할 수 있다. 사이클 0=150AV, 이후 100AV 단위. 사이클별 행동 횟수 표와 타임라인(markdown)을 돌려준다.',
    input: z.object({
      units: z.array(z.object({ name: z.string(), spd: z.number(), start_advance_pct: z.number().optional(), priority: z.number().optional() })).min(1),
      events: z
        .array(
          z.object({
            after: z.object({ actor: z.string(), nth: z.number().int().optional(), every: z.number().int().optional() }),
            target: z.string(),
            kind: z.enum(['advance', 'delay', 'spd_add', 'spd_pct', 'spd_set']),
            value: z.number(),
            duration: z.number().int().optional(),
            note: z.string().optional(),
          }),
        )
        .optional(),
      max_av: z.number().optional(),
      max_actions: z.number().int().optional(),
    }),
    run: async (args) => simulateTurns(args as any),
  },
  {
    name: 'hsr_check_updates',
    title: '위키 신규 항목·파서 상태 점검',
    description:
      '배포 시점의 기준선과 현재 위키를 비교해 새로 추가된 캐릭터·광추·유물 세트, 위키 내용이 새로 채워진 캐릭터, 전용 광추 자동 추정 결과, 새 캐릭터가 파서로 제대로 읽히는지(ready / pending_data / needs_attention)를 알려준다. ' +
      '서버는 위키를 실시간으로 읽으므로 새 항목은 이미 조회 가능하다. 이 툴은 "무엇이 새로 생겼고 믿고 써도 되는지"를 확인하는 용도이며, 매일 도는 크론(/api/cron/sync)과 같은 점검이다. ' +
      '덱 빌딩 중 이름을 못 찾았거나 최신 캐릭터가 포함된 경우, 또는 정기 점검 때 호출한다.',
    input: z.object({
      refresh: z.boolean().optional().describe('캐시를 무시하고 위키·StarRailRes를 다시 읽는다(기본 true)'),
      character_limit: z.number().int().min(0).max(30).optional().describe('새 캐릭터 상세 점검 최대 개수(기본 12)'),
    }),
    run: async ({ refresh = true, character_limit }, svc) => runSync(svc, { forceRefresh: refresh, characterLimit: character_limit }),
  },
  {
    name: 'hsr_server_info',
    title: '서버 상태',
    description: '서버 버전, 위키 목록 개수, 전용 광추 표 기준일, 보강 데이터(StarRailRes) 사용 가능 여부를 점검한다.',
    input: z.object({}),
    run: async (_a, svc) => {
      await ensureDerivedSignatures(svc.wiki);
      const [c, l, r] = await Promise.all([svc.wiki.listAll(MENU.character), svc.wiki.listAll(MENU.light_cone), svc.wiki.listAll(MENU.relic)]);
      const srr = await svc.srr.load();
      return {
        version: '0.1.0',
        wiki_counts: { characters: c.length, light_cones: l.length, relic_sets: r.length },
        baseline: {
          generated: BASELINE.generated,
          counts: { characters: Object.keys(BASELINE.characters).length, light_cones: Object.keys(BASELINE.light_cones).length, relic_sets: Object.keys(BASELINE.relics).length },
          new_since_baseline: {
            characters: c.filter((i) => !(String(i.entry_page_id) in BASELINE.characters)).length,
            light_cones: l.filter((i) => !(String(i.entry_page_id) in BASELINE.light_cones)).length,
            relic_sets: r.filter((i) => !(String(i.entry_page_id) in BASELINE.relics)).length,
          },
        },
        signature_map_built: SIGNATURE_BUILT,
        derived_signatures: derivedSignatureList().map((d) => ({ character: d.characterName, light_cones: d.light_cones })),
        starrailres_available: !!srr,
        access_key_configured: !!accessKey(),
        cron: {
          secret_configured: !!process.env.CRON_SECRET,
          webhook_configured: !!process.env.SYNC_WEBHOOK_URL,
          deploy_hook_configured: !!process.env.SYNC_DEPLOY_HOOK_URL,
        },
        now: new Date().toISOString(),
      };
    },
  },
];

function stripHints(rs: RelicSetData) {
  const { two_piece_hints, four_piece_hints, ...rest } = rs;
  return rest;
}

export function toContent(result: any): { type: 'text'; text: string }[] {
  const content: { type: 'text'; text: string }[] = [];
  if (result && typeof result === 'object' && typeof result.markdown === 'string' && result.markdown) {
    const { markdown, ...rest } = result;
    content.push({ type: 'text', text: `[바로 쓸 수 있는 표]\n${markdown}` });
    content.push({ type: 'text', text: JSON.stringify(rest) });
  } else {
    content.push({ type: 'text', text: JSON.stringify(result) });
  }
  return content;
}

export const ELEMENT_NAMES = ELEMENT_KO;
