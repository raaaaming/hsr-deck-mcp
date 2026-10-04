// 위키 신규/변경 항목 감지 + 파서 건강 점검 + 전용 광추 자동 추정.
//  - Vercel Cron(app/api/cron/sync)이 매일 호출하고, MCP 툴 hsr_check_updates로도 같은 점검을 할 수 있다.
//  - MCP 서버는 위키를 실시간으로 읽으므로 새 항목은 캐시 만료/갱신 후 자동으로 보인다. 이 모듈은 그 "신규"를
//    눈에 띄게 알리고, 새 캐릭터가 우리 파서로 제대로 읽히는지 미리 검증하며, 표에 없는 전용 광추를 채운다.

import baselineData from '../data/roster.json';
import { EntryPage, ListItem, MENU, WikiClient, fv } from './wiki';
import { SrrClient, enrichCharacter, enrichLightCone, findSrrCharacter, findSrrLightCone } from './enrich';
import { normalizeCharacter } from './character';
import { lcBaseFromEntry, lcBaseIncomplete, normalizeLightCone, normalizeRelicSet } from './lightcone';
import { htmlToText } from './html';
import { ELEMENT_FROM_KO, PATH_FROM_KO } from './stats';
import { normName } from './util';
import { DerivedSignature, SignatureLC, isStaticallyMapped, setDerivedSignatures, staticMappedLcIds } from './signature';

// ───────── 기준선(roster.json) ─────────

export interface Roster {
  generated: string;
  characters: Record<string, string>;
  light_cones: Record<string, string>;
  relics: Record<string, string>;
  /** 위키에 아직 내용이 없던 캐릭터 ID */
  pending: string[];
}

export const BASELINE = baselineData as unknown as Roster;

export interface Lists {
  characters: ListItem[];
  light_cones: ListItem[];
  relics: ListItem[];
}

export async function fetchLists(wiki: WikiClient, force = false): Promise<Lists> {
  const get = (m: '104' | '107' | '108') => (force ? wiki.refreshList(m, 0) : wiki.listAll(m));
  const [characters, light_cones, relics] = await Promise.all([get(MENU.character), get(MENU.light_cone), get(MENU.relic)]);
  return { characters, light_cones, relics };
}

export interface KindDiff {
  added: { id: string; name: string }[];
  removed: { id: string; name: string }[];
  renamed: { id: string; from: string; to: string }[];
}

export function diffKind(base: Record<string, string>, items: ListItem[]): KindDiff {
  const now = new Map(items.map((i) => [String(i.entry_page_id), String(i.name).trim()]));
  const out: KindDiff = { added: [], removed: [], renamed: [] };
  for (const [id, name] of now) {
    if (!(id in base)) out.added.push({ id, name });
    else if (normName(base[id]) !== normName(name)) out.renamed.push({ id, from: base[id], to: name });
  }
  for (const [id, name] of Object.entries(base)) if (!now.has(id)) out.removed.push({ id, name });
  out.added.sort((a, b) => Number(b.id) - Number(a.id));
  return out;
}

// ───────── 위키 본문(customize 모듈) 읽기 ─────────

/** 컴포넌트 data(JSON 문자열 → {data: html})를 HTML로 풀어 준다 */
function componentHtml(data: string): string {
  try {
    const j = JSON.parse(data);
    if (typeof j?.data === 'string') return j.data;
  } catch {
    /* 이미 HTML일 수 있다 */
  }
  return data;
}

function moduleHtmls(page: EntryPage, namePattern: RegExp): string[] {
  const out: string[] = [];
  for (const m of page.modules ?? []) {
    if (!namePattern.test(String(m.name))) continue;
    for (const c of m.components ?? []) if (c.data) out.push(componentHtml(c.data));
  }
  return out;
}

export interface EntryRef {
  epid: string;
  menuid: string;
  name: string;
  start: number;
  end: number;
}

/** <custom-entry epid="3698" name="…" menuid="107"></custom-entry> 태그들(문서 순서) */
export function entryRefs(html: string): EntryRef[] {
  const refs: EntryRef[] = [];
  const re = /<custom-entry\b[^>]*>\s*<\/custom-entry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const attr = (k: string) => tag.match(new RegExp(`${k}=\\\\?"([^"\\\\]*)`))?.[1] ?? '';
    refs.push({ epid: attr('epid'), menuid: attr('menuid'), name: htmlToText(attr('name')), start: m.index, end: m.index + tag.length });
  }
  return refs;
}

/**
 * 캐릭터 페이지의 「추천 세팅」에서 "{캐릭터}의 전용 광추"라고 적힌 광추를 찾는다.
 * (위키 작성자가 추천 광추의 '추천 이유' 칸에 적는 문구. 모든 캐릭터에 있지는 않지만 있으면 가장 직접적인 근거다.)
 */
export function signatureMentions(page: EntryPage, ownerName: string): { id: string; name: string }[] {
  const key = `${normName(ownerName)}의전용광추`;
  const found = new Map<string, string>();
  for (const html of moduleHtmls(page, /추천/)) {
    const refs = entryRefs(html);
    refs.forEach((r, i) => {
      if (r.menuid !== '107') return;
      const seg = html.slice(r.end, i + 1 < refs.length ? refs[i + 1].start : html.length);
      if (normName(htmlToText(seg)).includes(key)) found.set(r.epid, r.name);
    });
  }
  return [...found].map(([id, name]) => ({ id, name }));
}

// ───────── 전용 광추 자동 추정 ─────────

export interface SigSuggestion {
  character: { id: string; name: string; path: string | null };
  light_cone: { id: string; name: string };
  basis: 'wiki_recommendation' | 'warp_order';
  confidence: 'known' | 'probable';
  reason: string;
}

export interface SigUnresolved {
  character: { id: string; name: string; path: string | null };
  candidates: { id: string; name: string }[];
  reason: string;
}

const rarityOf = (it: ListItem, key: string) => Number((fv(it, key)[0] ?? '').replace('★', '')) || null;
const idNum = (it: { entry_page_id?: string; id?: string }) => Number(it.entry_page_id ?? it.id);

/**
 * 표(signature.json)에 없는 5성 캐릭터의 전용 광추를 추정한다.
 *  1) 캐릭터 페이지 「추천 세팅」에 "○○의 전용 광추"로 명시된 광추 → known
 *  2) 같은 운명의 길의 미배정 5성 '한정 워프' 광추와 미배정 5성 캐릭터를 ID 순서로 1:1 짝지음(개수가 같을 때만) → probable
 * 애매하면 추정하지 않고 unresolved로 돌려준다(틀린 매핑보다 빈 매핑이 안전하다).
 */
export async function deriveSignatures(wiki: WikiClient, lists: Lists): Promise<{ suggestions: SigSuggestion[]; unresolved: SigUnresolved[] }> {
  const mappedLcs = staticMappedLcIds();
  const lcs5 = lists.light_cones
    .map((it) => ({ it, lc: normalizeLightCone(it) }))
    .filter((x) => x.lc.rarity === 5)
    .map((x) => ({ id: x.lc.id, name: x.lc.name.trim(), path: x.lc.path, source: x.lc.source ?? '' }));
  const freeLcs = lcs5.filter((l) => !mappedLcs.has(l.id));
  const chars5 = lists.characters
    .filter((it) => rarityOf(it, 'character_rarity') === 5 && !isStaticallyMapped(String(it.entry_page_id)))
    .map((it) => {
      const pk = fv(it, 'character_paths')[0];
      return { it, id: String(it.entry_page_id), name: it.name.trim(), path: pk ? (PATH_FROM_KO[pk] ?? null) : null };
    });

  const suggestions: SigSuggestion[] = [];
  const unresolved: SigUnresolved[] = [];
  const claimed = new Set<string>();
  const rest: typeof chars5 = [];

  // 1) 위키 추천 세팅의 명시
  for (const c of chars5) {
    let page: EntryPage | null = null;
    try {
      page = await wiki.getEntry(c.id);
    } catch {
      /* 아래 2단계로 */
    }
    const hits = page ? signatureMentions(page, c.name) : [];
    const ok = hits.filter((h) => freeLcs.some((l) => l.id === h.id));
    if (ok.length) {
      for (const h of ok) {
        const known = freeLcs.find((l) => l.id === h.id)!;
        claimed.add(h.id);
        suggestions.push({
          character: { id: c.id, name: c.name, path: c.path },
          light_cone: { id: h.id, name: known.name },
          basis: 'wiki_recommendation',
          confidence: 'known',
          reason: '위키 캐릭터 페이지 「추천 세팅」에 "전용 광추"로 명시됨',
        });
      }
      continue;
    }
    if (hits.length) {
      unresolved.push({
        character: { id: c.id, name: c.name, path: c.path },
        candidates: hits,
        reason: '위키는 전용 광추를 지목했지만 이미 다른 캐릭터에 배정됐거나 5성이 아님 — 수동 확인 필요',
      });
      continue;
    }
    rest.push(c);
  }

  // 2) 같은 길의 미배정 한정 광추와 ID 순서 짝짓기
  const paths = [...new Set(rest.map((c) => c.path ?? ''))];
  for (const p of paths) {
    const cs = rest.filter((c) => (c.path ?? '') === p).sort((a, b) => Number(a.id) - Number(b.id));
    const pool = freeLcs.filter((l) => !claimed.has(l.id) && (l.path ?? '') === p && l.source === '한정 워프').sort((a, b) => Number(a.id) - Number(b.id));
    if (cs.length === pool.length && cs.length > 0) {
      cs.forEach((c, i) => {
        suggestions.push({
          character: { id: c.id, name: c.name, path: c.path },
          light_cone: { id: pool[i].id, name: pool[i].name },
          basis: 'warp_order',
          confidence: 'probable',
          reason: `같은 운명의 길의 미배정 5성 한정 캐릭터 ${cs.length}명과 한정 워프 광추 ${pool.length}개를 위키 ID 순서로 짝지음${cs.length > 1 ? '(여러 쌍이라 순서가 틀릴 수 있음)' : ''}`,
        });
      });
    } else {
      const candidates = freeLcs.filter((l) => !claimed.has(l.id) && (l.path ?? '') === p).map((l) => ({ id: l.id, name: l.name }));
      for (const c of cs) {
        unresolved.push({
          character: { id: c.id, name: c.name, path: c.path },
          candidates,
          reason: pool.length === 0 ? '같은 운명의 길에 아직 배정되지 않은 5성 한정 광추가 없음(광추 미등록이거나 시뮬레이션 우주/상시 광추)' : `미배정 캐릭터 ${cs.length}명 ↔ 한정 광추 ${pool.length}개로 개수가 달라 판단 보류`,
        });
      }
    }
  }
  return { suggestions, unresolved };
}

export function toDerived(suggestions: SigSuggestion[]): DerivedSignature[] {
  const by = new Map<string, DerivedSignature>();
  for (const s of suggestions) {
    const cur = by.get(s.character.id) ?? { characterId: s.character.id, characterName: s.character.name, light_cones: [] as SignatureLC[] };
    cur.light_cones.push({ id: s.light_cone.id, name: s.light_cone.name, confidence: s.confidence, basis: s.basis });
    by.set(s.character.id, cur);
  }
  return [...by.values()];
}

// 요청 경로에서 쓰는 느긋한 갱신(캐시 TTL 동안 재계산하지 않음)
let derivedAt = 0;
let derivedInflight: Promise<void> | null = null;

export function resetDerivedState() {
  derivedAt = 0;
  derivedInflight = null;
  setDerivedSignatures([]);
}

/** 표에 없는 새 5성 캐릭터의 전용 광추를 (캐시된) 위키 목록으로 추정해 signatureFor()가 쓰게 한다. 실패해도 조용히 넘어간다. */
export async function ensureDerivedSignatures(wiki: WikiClient, ttlMs = 6 * 3600_000): Promise<void> {
  if (Date.now() - derivedAt < ttlMs) return;
  if (!derivedInflight) {
    derivedInflight = (async () => {
      try {
        const lists = await fetchLists(wiki);
        const { suggestions } = await deriveSignatures(wiki, lists);
        setDerivedSignatures(toDerived(suggestions));
        derivedAt = Date.now();
      } catch {
        derivedAt = Date.now() - ttlMs + 5 * 60_000; // 5분 뒤 재시도
      } finally {
        derivedInflight = null;
      }
    })();
  }
  return derivedInflight;
}

// ───────── 신규 항목 점검 ─────────

export interface DataDeps {
  wiki: WikiClient;
  srr: SrrClient;
}

export interface CharacterCheck {
  id: string;
  name: string;
  rarity: number | null;
  element: string | null;
  path: string | null;
  /** ready: 바로 덱 빌딩에 쓸 수 있음 · pending_data: 위키에 아직 내용이 없음 · needs_attention: 읽히지만 이상 징후가 있음 · fetch_failed */
  status: 'ready' | 'pending_data' | 'needs_attention' | 'fetch_failed';
  issues: string[];
  starrailres: boolean;
}

const SKILL_KINDS = ['basic', 'skill', 'ultimate', 'talent'] as const;

export async function checkCharacter(deps: DataDeps, item: ListItem, srr: Awaited<ReturnType<SrrClient['load']>>): Promise<CharacterCheck> {
  const id = String(item.entry_page_id);
  const pk = fv(item, 'character_paths')[0];
  const ek = fv(item, 'character_combat_type')[0];
  const base = {
    id,
    name: item.name.trim(),
    rarity: rarityOf(item, 'character_rarity'),
    element: ek ? (ELEMENT_FROM_KO[ek] ?? null) : null,
    path: pk ? (PATH_FROM_KO[pk] ?? null) : null,
  };
  let page: EntryPage;
  try {
    page = await deps.wiki.getEntry(id);
  } catch (e: any) {
    return { ...base, status: 'fetch_failed', issues: [`상세 페이지를 읽지 못함: ${e?.message ?? e}`], starrailres: false };
  }
  const c = normalizeCharacter(page, item, { eidolon: 6 });
  if (c.incomplete) return { ...base, status: 'pending_data', issues: ['위키에 행적·능력치가 아직 입력되지 않음(미공개/미완성)'], starrailres: false };
  enrichCharacter(c, srr);
  const issues: string[] = [];
  const have = new Set(c.skills.map((s) => s.kind));
  for (const k of [...SKILL_KINDS, 'technique'] as const) if (!have.has(k)) issues.push(`스킬 종류 누락: ${k}`);
  if (c.minor_traces.count !== 10 || c.minor_traces.unparsed.length) issues.push(`작은 행적 ${c.minor_traces.count}개 읽음(미해석 ${c.minor_traces.unparsed.length})`);
  if (c.major_traces.length < 3) issues.push(`큰 행적 ${c.major_traces.length}개`);
  const b = c.base_stats_lv80;
  if (b.hp == null || b.atk == null || b.def == null || b.spd == null) issues.push('Lv.80 기초 능력치 누락');
  if (c.eidolons.length < 6) issues.push(`성혼 ${c.eidolons.length}개`);
  const hit = srr ? findSrrCharacter(c, srr) : null;
  if (!hit) issues.push('StarRailRes에 아직 없음 → 기초 능력치는 위키 정수 내림값(±1~3), 작은 행적도 위키 값에만 의존');
  // 경고 중 파싱 신뢰도와 관련된 것만 옮긴다(StarRailRes 미매칭 경고는 위에서 이미 안내)
  for (const w of c.warnings) if (!/StarRailRes/.test(w) && !issues.includes(w)) issues.push(w);
  const hard = issues.filter((x) => !/StarRailRes/.test(x));
  return { ...base, status: hard.length ? 'needs_attention' : 'ready', issues, starrailres: !!hit };
}

export interface LightConeCheck {
  id: string;
  name: string;
  rarity: number | null;
  path_ko: string | null;
  source: string | null;
  base_stats: boolean;
  starrailres: boolean;
  /** 5성 한정 워프 광추 중 아직 전용 광추 표에 없는 것 */
  unassigned_signature_candidate: boolean;
  issues: string[];
}

export async function checkLightCone(deps: DataDeps, item: ListItem, srr: Awaited<ReturnType<SrrClient['load']>>): Promise<LightConeCheck> {
  const lc = normalizeLightCone(item, 1);
  const issues: string[] = [];
  if (lcBaseIncomplete(lc)) {
    try {
      const b = lcBaseFromEntry(await deps.wiki.getEntry(item.entry_page_id));
      if (b && b.hp != null && b.atk != null && b.def != null) lc.base_stats_lv80 = { ...b, source: 'wiki 상세(정수 내림값)' };
    } catch {
      /* 아래에서 누락으로 보고 */
    }
  }
  enrichLightCone(lc, srr);
  const b = lc.base_stats_lv80;
  const baseOk = b.hp != null && b.atk != null && b.def != null;
  if (!baseOk) issues.push('Lv.80 기초 능력치를 읽지 못함');
  if (!lc.passive_text) issues.push('패시브 효과 문구가 비어 있음(위키 미입력일 수 있음)');
  if (!lc.rarity || !lc.path) issues.push('희귀도/운명의 길 정보 누락');
  for (const n of lc.notes ?? []) issues.push(n);
  const hit = srr ? findSrrLightCone(lc, srr) : null;
  if (!hit) issues.push('StarRailRes에 아직 없음 → 기초 능력치는 위키 정수 내림값');
  const mapped = staticMappedLcIds();
  return {
    id: lc.id,
    name: lc.name.trim(),
    rarity: lc.rarity,
    path_ko: lc.path_ko,
    source: lc.source ?? null,
    base_stats: baseOk,
    starrailres: !!hit,
    unassigned_signature_candidate: lc.rarity === 5 && lc.source === '한정 워프' && !mapped.has(lc.id),
    issues,
  };
}

export interface RelicCheck {
  id: string;
  name: string;
  type: 'cavern' | 'planar';
  two_piece: string;
  four_piece: string | null;
  stat_hints_found: number;
  issues: string[];
}

export function checkRelic(item: ListItem): RelicCheck {
  const rs = normalizeRelicSet(item);
  const issues: string[] = [];
  if (!rs.two_piece) issues.push('2세트 효과 문구가 비어 있음');
  if (rs.type === 'cavern' && !rs.four_piece) issues.push('4세트 효과 문구가 비어 있음(동굴 유물인데 4세트 없음 → 분류 확인)');
  return {
    id: rs.id,
    name: rs.name.trim(),
    type: rs.type,
    two_piece: rs.two_piece,
    four_piece: rs.four_piece,
    stat_hints_found: rs.two_piece_hints.length + rs.four_piece_hints.length,
    issues,
  };
}

// ───────── 전체 점검 ─────────

export interface SyncOptions {
  /** true면 위키 목록/StarRailRes 캐시를 무시하고 다시 읽는다(cron 기본) */
  forceRefresh?: boolean;
  /** 새 캐릭터 상세 점검 최대 개수 */
  characterLimit?: number;
  lightConeLimit?: number;
  /** 테스트용으로 기준선 교체 */
  baseline?: Roster;
}

export interface SyncReport {
  generated_at: string;
  baseline_generated: string;
  current_counts: { characters: number; light_cones: number; relic_sets: number };
  baseline_counts: { characters: number; light_cones: number; relic_sets: number };
  /** 한눈에 보는 요약(한국어) */
  summary: string[];
  new_characters: CharacterCheck[];
  new_light_cones: LightConeCheck[];
  new_relic_sets: RelicCheck[];
  /** 기준선에서 "위키 내용 없음"이던 캐릭터 중 이제 채워진 것 */
  became_ready: CharacterCheck[];
  still_pending: { id: string; name: string }[];
  renamed: { kind: 'character' | 'light_cone' | 'relic'; id: string; from: string; to: string }[];
  removed: { kind: 'character' | 'light_cone' | 'relic'; id: string; name: string }[];
  signature: { suggestions: SigSuggestion[]; unresolved: SigUnresolved[] };
  skipped: string[];
  starrailres_loaded: boolean;
  elapsed_ms: number;
  /** 새 항목이 있어 사람이 확인/조치할 일이 있는가 */
  needs_attention: boolean;
}

export async function runSync(deps: DataDeps, opts: SyncOptions = {}): Promise<SyncReport> {
  const t0 = Date.now();
  const base = opts.baseline ?? BASELINE;
  const force = opts.forceRefresh ?? true;
  const srr = force ? await deps.srr.refresh(0) : await deps.srr.load();
  const lists = await fetchLists(deps.wiki, force);

  const dc = diffKind(base.characters, lists.characters);
  const dl = diffKind(base.light_cones, lists.light_cones);
  const dr = diffKind(base.relics, lists.relics);
  const byId = (items: ListItem[]) => new Map(items.map((i) => [String(i.entry_page_id), i]));
  const chars = byId(lists.characters);
  const lcs = byId(lists.light_cones);
  const rels = byId(lists.relics);
  const skipped: string[] = [];

  const cLimit = opts.characterLimit ?? 12;
  const newChars = dc.added.slice(0, cLimit);
  if (dc.added.length > cLimit) skipped.push(`새 캐릭터 ${dc.added.length - cLimit}명은 점검 한도(${cLimit})를 넘어 상세 점검을 생략`);
  const lLimit = opts.lightConeLimit ?? 40;
  const newLcs = dl.added.slice(0, lLimit);
  if (dl.added.length > lLimit) skipped.push(`새 광추 ${dl.added.length - lLimit}개는 점검 한도(${lLimit})를 넘어 상세 점검을 생략`);

  const [newCharChecks, newLcChecks] = await Promise.all([
    Promise.all(newChars.map((a) => checkCharacter(deps, chars.get(a.id)!, srr))),
    Promise.all(newLcs.map((a) => checkLightCone(deps, lcs.get(a.id)!, srr))),
  ]);
  const newRelicChecks = dr.added.map((a) => checkRelic(rels.get(a.id)!));

  // 기준선에서 비어 있던 캐릭터가 채워졌는지
  const readyNow: CharacterCheck[] = [];
  const stillPending: { id: string; name: string }[] = [];
  for (const pid of base.pending ?? []) {
    const it = chars.get(String(pid));
    if (!it) continue;
    const chk = await checkCharacter(deps, it, srr);
    if (chk.status === 'pending_data') stillPending.push({ id: chk.id, name: chk.name });
    else readyNow.push(chk);
  }
  for (const c of newCharChecks) if (c.status === 'pending_data') stillPending.push({ id: c.id, name: c.name });

  const signature = await deriveSignatures(deps.wiki, lists);
  setDerivedSignatures(toDerived(signature.suggestions)); // 같은 인스턴스의 이후 요청에 바로 반영

  const renamed = [
    ...dc.renamed.map((r) => ({ kind: 'character' as const, ...r })),
    ...dl.renamed.map((r) => ({ kind: 'light_cone' as const, ...r })),
    ...dr.renamed.map((r) => ({ kind: 'relic' as const, ...r })),
  ];
  const removed = [
    ...dc.removed.map((r) => ({ kind: 'character' as const, ...r })),
    ...dl.removed.map((r) => ({ kind: 'light_cone' as const, ...r })),
    ...dr.removed.map((r) => ({ kind: 'relic' as const, ...r })),
  ];

  const summary: string[] = [];
  summary.push(
    `기준선(${base.generated.slice(0, 10)}) 대비 신규: 캐릭터 ${dc.added.length}명, 광추 ${dl.added.length}개, 유물 세트 ${dr.added.length}개` +
      (renamed.length ? `, 이름 변경 ${renamed.length}건` : '') +
      (removed.length ? `, 삭제 ${removed.length}건` : ''),
  );
  for (const c of newCharChecks) summary.push(`신규 캐릭터 ${c.name}(${c.id}): ${statusKo(c.status)}${c.issues.length ? ' — ' + c.issues.slice(0, 2).join(' / ') : ''}`);
  for (const l of newLcChecks) summary.push(`신규 광추 ${l.name}(${l.id}, ${l.rarity ?? '?'}★ ${l.path_ko ?? '?'})${l.issues.length ? ' — ' + l.issues.slice(0, 2).join(' / ') : ''}`);
  for (const r of newRelicChecks) summary.push(`신규 유물 ${r.name}(${r.id}, ${r.type === 'cavern' ? '동굴' : '장신구'})${r.issues.length ? ' — ' + r.issues.join(' / ') : ''}`);
  for (const c of readyNow) summary.push(`위키 내용이 채워진 캐릭터: ${c.name}(${c.id}) — ${statusKo(c.status)}`);
  for (const s of signature.suggestions) summary.push(`전용 광추 추정: ${s.character.name} → ${s.light_cone.name} (${s.confidence}, ${s.basis === 'wiki_recommendation' ? '위키 추천 세팅 명시' : '배너 순서 추정'})`);
  for (const u of signature.unresolved) summary.push(`전용 광추 판단 보류: ${u.character.name} — ${u.reason}`);

  const attention =
    newCharChecks.some((c) => c.status !== 'ready') ||
    newLcChecks.some((l) => l.issues.some((x) => !/StarRailRes/.test(x))) ||
    newRelicChecks.some((r) => r.issues.length > 0) ||
    signature.suggestions.length + signature.unresolved.length > 0 ||
    renamed.length + removed.length > 0 ||
    readyNow.some((c) => c.status !== 'ready');

  return {
    generated_at: new Date().toISOString(),
    baseline_generated: base.generated,
    current_counts: { characters: lists.characters.length, light_cones: lists.light_cones.length, relic_sets: lists.relics.length },
    baseline_counts: {
      characters: Object.keys(base.characters).length,
      light_cones: Object.keys(base.light_cones).length,
      relic_sets: Object.keys(base.relics).length,
    },
    summary,
    new_characters: newCharChecks,
    new_light_cones: newLcChecks,
    new_relic_sets: newRelicChecks,
    became_ready: readyNow,
    still_pending: stillPending,
    renamed,
    removed,
    signature,
    skipped,
    starrailres_loaded: !!srr,
    elapsed_ms: Date.now() - t0,
    needs_attention: attention,
  };
}

function statusKo(s: CharacterCheck['status']): string {
  return { ready: '바로 사용 가능', pending_data: '위키 내용 미입력', needs_attention: '읽히지만 확인 필요', fetch_failed: '상세 페이지 읽기 실패' }[s];
}

/** 위키에 새로 추가된 항목이 있는지 가볍게 확인(상세 점검 없이 ID 비교만) */
export async function quickDiff(wiki: WikiClient, force = true, baseline: Roster = BASELINE) {
  const lists = await fetchLists(wiki, force);
  return {
    characters: diffKind(baseline.characters, lists.characters),
    light_cones: diffKind(baseline.light_cones, lists.light_cones),
    relics: diffKind(baseline.relics, lists.relics),
    counts: { characters: lists.characters.length, light_cones: lists.light_cones.length, relic_sets: lists.relics.length },
  };
}

/** 현재 위키 목록으로 기준선(roster.json)을 만든다. 이전 기준선의 pending/신규만 상세 확인한다. */
export async function buildRoster(deps: DataDeps, prev: Roster = BASELINE, now = new Date()): Promise<Roster> {
  const lists = await fetchLists(deps.wiki, true);
  const nameMap = (items: ListItem[]) => Object.fromEntries(items.map((i) => [String(i.entry_page_id), String(i.name).trim()]));
  const characters = nameMap(lists.characters);
  const pending: string[] = [];
  const toCheck = new Set<string>([...(prev.pending ?? []), ...Object.keys(characters).filter((id) => !(id in prev.characters))]);
  for (const id of toCheck) {
    const it = lists.characters.find((i) => String(i.entry_page_id) === id);
    if (!it) continue;
    try {
      const c = normalizeCharacter(await deps.wiki.getEntry(id), it, { eidolon: 0 });
      if (c.incomplete) pending.push(id);
    } catch {
      pending.push(id);
    }
  }
  return {
    generated: now.toISOString(),
    characters,
    light_cones: nameMap(lists.light_cones),
    relics: nameMap(lists.relics),
    pending,
  };
}
