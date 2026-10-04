// 위키 캐릭터 항목 → 정규화된 구조.
// 최신 캐릭터(P01~P22 키)와 구형 캐릭터(A/B/C… 키)가 섞여 있고, 머리글("<일반 공격>")이 빠졌거나
// 꺾쇠 없이 적힌 항목, 속성 보너스 머리글을 달고 있는 추가 능력 등 위키 입력 오류가 있으므로
// 키가 아니라 머리글 + 내용 모양(표 유무, 한 줄 스탯 문장 여부)을 함께 보고 판별한다.

import { component, EntryPage, ListItem, fv } from './wiki';
import { htmlToText, parseTable } from './html';
import {
  ELEMENT_FROM_KO,
  PATH_FROM_KO,
  StatHint,
  TraceStat,
  extractStatHints,
  parseStatPhrase,
} from './stats';
import { r2, toNum } from './util';

export type SkillKind =
  | 'basic'
  | 'skill'
  | 'ultimate'
  | 'talent'
  | 'technique'
  | 'elation_skill'
  | 'memosprite_skill'
  | 'memosprite_talent'
  | 'other';

export const SKILL_KIND_KO: Record<SkillKind, string> = {
  basic: '일반 공격',
  skill: '전투 스킬',
  ultimate: '필살기',
  talent: '특성',
  technique: '비술',
  elation_skill: '환락 스킬',
  memosprite_skill: '기억 정령 스킬',
  memosprite_talent: '기억 정령 특성',
  other: '기타',
};

/** 게임 규칙상 스킬 종류별 기본 최대 레벨(성혼 보너스 제외) */
export const BASE_LEVEL_CAP: Partial<Record<SkillKind, number>> = {
  basic: 6,
  skill: 10,
  ultimate: 10,
  talent: 10,
  elation_skill: 10,
  memosprite_skill: 6,
  memosprite_talent: 6,
};

/** 성혼으로 오를 수 있는 레벨 합계의 상한(위키 문구가 중복·오기되어도 넘지 않게) */
export const BONUS_TOTAL_CAP: Partial<Record<SkillKind, number>> = {
  basic: 1,
  skill: 2,
  ultimate: 2,
  talent: 2,
  elation_skill: 2,
  memosprite_skill: 1,
  memosprite_talent: 1,
};

type PointClass = SkillKind | 'major' | 'minor' | 'unknown';

interface RawPoint {
  key: string;
  title: string;
  desc: string;
  form: string;
}

export interface SkillRow {
  label: string;
  value: string;
  all?: string[];
}

export interface SkillOut {
  key: string;
  kind: SkillKind;
  kind_ko: string;
  title: string;
  tags?: string;
  toughness?: number;
  energy?: number;
  text: string;
  max_level: number;
  level_used?: number;
  rows?: SkillRow[];
}

export interface MinorTrace extends TraceStat {
  key: string;
  title: string;
}

export interface MajorTrace {
  key: string;
  title: string;
  text: string;
  hints: StatHint[];
}

export interface Eidolon {
  rank: number;
  name: string;
  text: string;
  level_bonus: Partial<Record<SkillKind, number>>;
  hints: StatHint[];
}

export interface MinorTraceTotals {
  [stat: string]: { pct?: number; flat?: number; element?: string };
}

export interface CharacterData {
  id: string;
  name: string;
  rarity: number | null;
  element: string | null;
  element_ko: string | null;
  path: string | null;
  path_ko: string | null;
  faction: string | null;
  /** 위키에 상세 데이터(행적·능력치)가 아직 없는 항목 */
  incomplete?: boolean;
  base_stats_lv80: {
    hp: number | null;
    atk: number | null;
    def: number | null;
    spd: number | null;
    energy_cost?: number;
    taunt?: number;
    crit_rate: number;
    crit_dmg: number;
    source: string;
  };
  minor_traces: {
    count: number;
    items: MinorTrace[];
    totals: MinorTraceTotals;
    unparsed: string[];
    source?: string;
  };
  major_traces: MajorTrace[];
  skills: SkillOut[];
  eidolons: Eidolon[];
  /** 스킬 레벨을 계산할 때 개방한 것으로 본 성혼 수(0~6) */
  eidolon_rank: number;
  /** 성혼의 스킬 레벨 보너스(eidolons[].level_bonus)를 어디서 읽었나 */
  eidolon_level_bonus_source: string;
  skill_levels: Record<string, number>;
  enhanced_skills?: SkillOut[];
  warnings: string[];
}

// ───────── 머리글 ─────────

const HEADERS: [RegExp, PointClass][] = [
  [/^일반\s*공격$/, 'basic'],
  [/^전투\s*스킬$/, 'skill'],
  [/^필살기$/, 'ultimate'],
  [/^특성$/, 'talent'],
  [/^비술$/, 'technique'],
  [/^추가\s*능력$/, 'major'],
  [/^속성\s*보너스$/, 'minor'],
  [/^환락\s*스킬$/, 'elation_skill'],
  [/^(?:기억\s*)?정령\s*(?:전투\s*)?스킬$/, 'memosprite_skill'],
  [/^(?:기억\s*)?정령\s*특성$/, 'memosprite_talent'],
];

function exactHeader(h: string): PointClass | null {
  const s = h.trim();
  for (const [re, c] of HEADERS) if (re.test(s)) return c;
  return null;
}

function classifyHeader(h: string): PointClass {
  const exact = exactHeader(h);
  if (exact) return exact;
  const s = h.trim();
  if (/정령.*스킬/.test(s)) return 'memosprite_skill';
  if (/정령.*특성/.test(s)) return 'memosprite_talent';
  if (/스킬/.test(s)) return 'other';
  return 'unknown';
}

/** 머리글을 뗀 나머지 줄. 꺾쇠 없는 평문 머리글("필살기")도 인식한다. */
function splitDesc(descHtml: string): { header: string | null; lines: string[] } {
  const text = htmlToText(descHtml);
  const lines = text.split('\n');
  let header: string | null = null;
  const first = (lines[0] ?? '').trim();
  if (/^<[^<>]+>$/.test(first)) {
    header = first.slice(1, -1);
    lines.shift();
  } else {
    const m = text.match(/^<([^<>]{1,16})>/);
    if (m) {
      header = m[1];
      lines[0] = lines[0].replace(/^<[^<>]*>\s*/, '');
    } else if (first.length <= 14 && exactHeader(first)) {
      header = first;
      lines.shift();
    }
  }
  return { header, lines };
}

// 태그줄: "[단일 공격] | 강인성 감소 수치: 10", "단일공격 | 강인성 …", "범위 공격 | 에너지 소모 140 | …", "서포트", "강화"
const TAG_LINE = /^(?:\[[^\]]{1,14}\]|[가-힣]{1,6}(?: [가-힣]{1,6})?)(?:\s*\|.*)?$/;

function extractTags(lines: string[]): { tags?: string; body: string } {
  const rest = [...lines];
  let tags: string | undefined;
  if (rest.length > 1 && TAG_LINE.test(rest[0].trim()) && rest[0].length < 100) tags = rest.shift()!.trim();
  return { tags, body: rest.join('\n').trim() };
}

// ───────── 행적 종류 판별 보조 ─────────

const TITLE_STAT_BOOST = /강화(?:\s*[•ㆍ·]\s*.{1,6})?$/;
const PURE_STAT_LINE = /^(?:[가-힣A-Za-z ·•ㆍ()]{1,18}\s)?[+]?\d+(?:\.\d+)?\s*%?\s*(?:증가|상승)$/;

/** 속성 보너스(작은 행적) 한 줄 문장처럼 생겼는가 */
function statLike(title: string, body: string): boolean {
  const b = body.replace(/\s+/g, ' ').trim();
  if (PURE_STAT_LINE.test(b)) return true;
  return TITLE_STAT_BOOST.test(title.trim()) && b.length <= 40;
}

function looksTechnique(body: string): boolean {
  return /^비술(?:을)?(?:\s|$)/.test(body) || /비술(?:을)?\s*사용(?:하|한|\s)/.test(body.slice(0, 40));
}

function collectPoints(points: Record<string, any> | undefined): RawPoint[] {
  if (!points) return [];
  const out: RawPoint[] = [];
  for (const [key, v] of Object.entries(points)) {
    if (!v || typeof v !== 'object') continue;
    const desc = String(v.desc ?? '');
    const title = htmlToText(v.title ?? '');
    if (!desc.trim() && !title) continue;
    out.push({ key, title, desc, form: String(v.form ?? '') });
  }
  return out;
}

// ───────── 레벨 표 ─────────

interface LevelTable {
  levels: number;
  rows: { label: string; values: string[] }[];
}

function parseLevelTable(formHtml: string): LevelTable {
  const rows = parseTable(formHtml);
  if (!rows.length) return { levels: 0, rows: [] };
  const head = rows.find((r) => /레벨|level/i.test(r[0] ?? '') && r.filter((c) => c !== '').length >= 3) ?? null;
  if (!head) return { levels: 0, rows: [] };
  const heads = [...head];
  while (heads.length && heads[heads.length - 1] === '') heads.pop();
  const levels = heads.length - 1;
  if (levels < 2) return { levels: 0, rows: [] }; // 행적 레벨 1짜리 표(작은 행적 등)는 스킬 표가 아니다
  const out: LevelTable['rows'] = [];
  for (const r of rows) {
    if (r === head) continue;
    const label = (r[0] ?? '').trim();
    if (!label || /승급\s*재료/.test(label)) continue;
    const values = r.slice(1);
    while (values.length && values[values.length - 1] === '') values.pop();
    if (!values.length || values.every((v) => v === '' || v === '-')) continue;
    out.push({ label, values });
  }
  return { levels, rows: out };
}

// ───────── 성혼의 스킬 레벨 보너스 ─────────

function bonusKind(label: string): SkillKind | null {
  const s = label.replace(/\s+/g, '');
  if (s.includes('정령') && s.includes('스킬')) return 'memosprite_skill';
  if (s.includes('정령') && s.includes('특성')) return 'memosprite_talent';
  if (s.includes('환락')) return 'elation_skill';
  if (/일반|평타|기본/.test(s)) return 'basic';
  if (s.includes('필살')) return 'ultimate';
  if (s.includes('특성')) return 'talent';
  if (s.includes('스킬')) return 'skill'; // "전투 스킬", 오기된 "저투 스킬", "스킬"
  return null;
}

/** "필살기 레벨+2, 최대 Lv.15. 일반 공격 레벨+1 …" → { ultimate: 2, basic: 1 } (같은 종류가 반복되면 최댓값) */
export function parseLevelBonus(text: string): Partial<Record<SkillKind, number>> {
  const out: Partial<Record<SkillKind, number>> = {};
  let prevEnd = 0;
  for (const m of text.matchAll(/레벨\s*\+\s*(\d+)/g)) {
    const idx = m.index ?? 0;
    let label = text.slice(prevEnd, idx);
    const cut = Math.max(label.lastIndexOf('.'), label.lastIndexOf(','), label.lastIndexOf(':'), label.lastIndexOf('\n'), label.lastIndexOf('。'), label.lastIndexOf('，'));
    label = label.slice(cut + 1).trim();
    prevEnd = idx + m[0].length;
    const kind = bonusKind(label);
    if (!kind) continue;
    out[kind] = Math.max(out[kind] ?? 0, parseInt(m[1], 10));
  }
  return out;
}

function parseEidolons(page: EntryPage): Eidolon[] {
  const sl = component<{ list: { name?: string; desc?: string }[] }>(page, 'summaryList');
  const list = sl?.list ?? [];
  return list.slice(0, 6).map((e, i) => {
    const text = htmlToText(e.desc ?? '');
    return {
      rank: i + 1,
      name: htmlToText(e.name ?? ''),
      text,
      level_bonus: parseLevelBonus(text),
      hints: extractStatHints(text),
    };
  });
}

// ───────── 기초 능력치 ─────────

function parseBaseStats(page: EntryPage): { hp: number | null; atk: number | null; def: number | null; spd: number | null } {
  const asc = component<{ list: { key: string; combatList: { key: string; values: string[] }[] }[] }>(page, 'ascension');
  // "Lv. 80", "Lv.80", 오기된 "Lv.. 80" 모두 허용
  const lv80 = asc?.list?.find((e) => /^lv\W*80$/i.test(String(e.key).trim()));
  const pick = (re: RegExp): number | null => {
    const row = lv80?.combatList?.find((c) => re.test(c.key));
    if (!row) return null;
    // Lv.80은 "돌파 전" 값이 80레벨 기초값, "돌파 후"는 '-'
    return toNum(row.values?.[0]) ?? toNum(row.values?.[1]);
  };
  return { hp: pick(/HP/i), atk: pick(/공격력/), def: pick(/방어력/), spd: pick(/속도/) };
}

// ───────── 행적/스킬 분류 ─────────

function buildSkills(
  points: RawPoint[],
  warnings: string[],
): { skills: SkillOut[]; major: MajorTrace[]; minor: MinorTrace[]; unparsed: string[] } {
  const skills: SkillOut[] = [];
  const major: MajorTrace[] = [];
  const minor: MinorTrace[] = [];
  const unparsed: string[] = [];
  const pendingOther: SkillOut[] = [];

  for (const p of points) {
    const { header, lines } = splitDesc(p.desc);
    const fullBody = lines.join('\n').trim();
    const table = parseLevelTable(p.form);
    const leveled = table.levels >= 2;
    let cls: PointClass = header ? classifyHeader(header) : 'unknown';
    let why = '';

    if (cls === 'unknown') {
      // 비술은 레벨이 없다. 위키가 비술에 다른 스킬의 레벨 표를 잘못 붙인 경우(개척자 기억)도 본문이 "비술 사용 후…"면 비술이다.
      if (looksTechnique(fullBody)) cls = 'technique';
      else if (leveled) {
        // 키 F1/F2는 기억 정령 특성/스킬 칸(머리글이 빠진 경우)
        if (/^F1$/i.test(p.key)) cls = 'memosprite_talent';
        else if (/^F2$/i.test(p.key)) cls = 'memosprite_skill';
        else cls = 'other';
      } else if (statLike(p.title, fullBody)) cls = 'minor';
      else cls = fullBody ? 'major' : 'unknown';
      why = `머리글 "${header ?? '없음'}" 없음/낯섦`;
    } else if (cls === 'minor' && !statLike(p.title, fullBody)) {
      cls = 'major';
      why = '속성 보너스 머리글이지만 서술형 효과';
    }
    if (why) warnings.push(`행적 ${p.key}(${p.title.slice(0, 12)}): ${why} → ${cls}로 분류`);

    if (cls === 'minor') {
      const st = parseStatPhrase(fullBody) ?? parseStatPhrase(`${p.title} ${fullBody}`);
      if (st) minor.push({ key: p.key, title: p.title, ...st });
      else unparsed.push(`${p.key}(${p.title}): ${fullBody.slice(0, 40) || '값 없음'}`);
      continue;
    }
    if (cls === 'major') {
      major.push({ key: p.key, title: p.title, text: fullBody, hints: extractStatHints(fullBody) });
      continue;
    }
    if (cls === 'unknown') continue;

    const { tags, body } = extractTags(lines);
    const head = [tags ?? '', ...body.split('\n').slice(0, 2)].join(' | ');
    const toughness = toNum(head.match(/강인성\s*감소\s*수치\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1]);
    const energy = toNum(head.match(/에너지\s*소모\s*[:：]?\s*(\d+)/)?.[1]);
    const kind = cls as SkillKind;
    const sk: SkillOut = {
      key: p.key,
      kind,
      kind_ko: SKILL_KIND_KO[kind],
      title: p.title,
      tags,
      toughness: toughness ?? undefined,
      energy: energy ?? undefined,
      text: body,
      // 비술에는 레벨이 없다(잘못 붙은 표는 버린다)
      max_level: kind === 'technique' ? 0 : table.levels,
      rows: kind === 'technique' ? [] : table.rows.map((r) => ({ label: r.label, value: r.values[r.values.length - 1] ?? '', all: r.values })),
    };
    skills.push(sk);
    if (kind === 'other') pendingOther.push(sk);
  }

  // 같은 종류(일반/전투/필살/특성)가 둘이면 레벨 표가 없는 쪽이 비술이다(예: 비술에 <특성> 머리글을 단 오기)
  for (const k of ['basic', 'skill', 'ultimate', 'talent'] as SkillKind[]) {
    const same = skills.filter((s) => s.kind === k);
    if (same.length < 2) continue;
    const noTable = same.filter((s) => s.max_level === 0);
    if (noTable.length === 1 && !skills.some((s) => s.kind === 'technique')) {
      noTable[0].kind = 'technique';
      noTable[0].kind_ko = SKILL_KIND_KO.technique;
      warnings.push(`스킬 ${noTable[0].key}(${noTable[0].title}): ${SKILL_KIND_KO[k]} 머리글이 중복되어 레벨 표가 없는 항목을 비술로 분류`);
    } else {
      warnings.push(`${SKILL_KIND_KO[k]}로 분류된 스킬이 ${same.length}개입니다(${same.map((s) => s.key).join(', ')}).`);
    }
  }

  // 종류를 알 수 없는 레벨 있는 스킬: 비어 있는 기본 스킬 칸에 순서대로 배정
  if (pendingOther.length) {
    const order: SkillKind[] = ['basic', 'skill', 'ultimate', 'talent'];
    const have = new Set(skills.filter((s) => s.kind !== 'other').map((s) => s.kind));
    for (const sk of pendingOther) {
      const next = order.find((k) => !have.has(k));
      if (next) {
        have.add(next);
        sk.kind = next;
        sk.kind_ko = SKILL_KIND_KO[next];
        warnings.push(`스킬 ${sk.key}(${sk.title})의 종류를 소거법으로 ${sk.kind_ko}로 배정`);
      }
    }
  }
  return { skills, major, minor, unparsed };
}

/**
 * 성혼 보너스를 반영한 스킬 레벨 = 기본 최대 레벨 + 개방한 성혼의 보너스(합계 상한 적용).
 * 위키 표는 캐릭터마다 수록 레벨 수가 다르므로(10/12/15) 표 길이에서 기본 레벨을 역산하지 않고,
 * 표에 없는 레벨은 표의 마지막 값으로 대체하며 알린다.
 */
export function computeSkillLevels(skills: SkillOut[], eidolons: Eidolon[], eidolonRank: number, notes?: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sk of skills) {
    if (sk.max_level <= 0) continue;
    const cap = BASE_LEVEL_CAP[sk.kind];
    if (cap == null) {
      out[sk.key] = sk.max_level;
      continue;
    }
    const gainedRaw = eidolons.filter((e) => e.rank <= eidolonRank).reduce((a, e) => a + (e.level_bonus[sk.kind] ?? 0), 0);
    const gained = Math.min(gainedRaw, BONUS_TOTAL_CAP[sk.kind] ?? gainedRaw);
    const want = cap + gained;
    const used = Math.max(1, Math.min(sk.max_level, want));
    out[sk.key] = used;
    if (want > sk.max_level) notes?.push(`${sk.kind_ko}(${sk.key})는 위키 표가 Lv.${sk.max_level}까지만 수록되어 목표 Lv.${want} 대신 Lv.${used} 수치를 표시합니다.`);
  }
  return out;
}

/** computeSkillLevels가 남기는 안내 문구(다시 계산할 때 이전 안내를 지우기 위한 식별용) */
const LEVEL_NOTE_RE = /위키 표가 Lv\.\d+까지만 수록/;

/**
 * 성혼 수·성혼 보너스를 바탕으로 skill_levels / level_used / 안내 문구를 (다시) 계산한다.
 * StarRailRes로 성혼 보너스를 바로잡은 뒤 호출해서 위키 오기가 스킬 레벨에 남지 않게 한다.
 */
export function recomputeSkillLevels(c: CharacterData): void {
  c.warnings = c.warnings.filter((w) => !LEVEL_NOTE_RE.test(w));
  c.skill_levels = computeSkillLevels(c.skills, c.eidolons, c.eidolon_rank, c.warnings);
  for (const sk of c.skills) {
    const lv = c.skill_levels[sk.key];
    if (lv) sk.level_used = lv;
    else delete sk.level_used;
  }
}

export function normalizeCharacter(page: EntryPage, listItem?: ListItem, opts: { eidolon?: number } = {}): CharacterData {
  const warnings: string[] = [];
  const eidolonRank = Math.max(0, Math.min(6, opts.eidolon ?? 0));
  const src = { filter_values: page.filter_values ?? listItem?.filter_values };

  const rarityTxt = fv(src, 'character_rarity')[0] ?? '';
  const rarity = toNum(rarityTxt.replace('★', ''));
  const elementKo = fv(src, 'character_combat_type')[0] ?? null;
  const pathKo = fv(src, 'character_paths')[0] ?? null;
  const faction = fv(src, 'character_factions')[0] ?? null;

  const trace = component<{ points?: Record<string, any>; isEnhanced?: boolean; pointsEnhanced?: Record<string, any> }>(page, 'trace');
  if (!trace) warnings.push('행적(trace) 데이터가 없습니다 — 위키에 아직 정보가 입력되지 않은 캐릭터일 수 있습니다.');
  const built = buildSkills(collectPoints(trace?.points), warnings);

  const eidolons = parseEidolons(page);
  if (eidolons.length < 6) warnings.push(`성혼 정보가 ${eidolons.length}개뿐입니다.`);

  const stats = parseBaseStats(page);
  if (stats.hp == null) warnings.push('Lv.80 기초 능력치를 찾지 못했습니다.');

  // 행적 칸은 있어도 비어 있고 기초 능력치도 없으면 위키에 아직 내용이 입력되지 않은 항목(예: 에이언즈★아하)
  const incomplete = stats.hp == null && !built.skills.length && !built.minor.length && !built.major.length && !built.unparsed.length;
  if (!incomplete) {
    const minorN = built.minor.length + built.unparsed.length;
    if (minorN !== 10) warnings.push(`작은 행적이 ${minorN}개로 파악되었습니다(보통 10개).`);
    // 개척자(기억)는 개척 임무로 여는 4번째 큰 행적이 있다
    const majorOk = built.major.length === 3 || (built.major.length === 4 && built.major.some((m) => /개척\s*임무|임무\s*완료/.test(m.text)));
    if (!majorOk) warnings.push(`큰 행적(추가 능력)이 ${built.major.length}개로 파악되었습니다(보통 3개).`);
    if (built.unparsed.length) warnings.push(`작은 행적 ${built.unparsed.length}개의 값을 위키에서 읽지 못했습니다: ${built.unparsed.join(' / ')}`);
  }

  const totals = sumMinor(built.minor);

  const enhancedPoints = trace?.isEnhanced || (trace?.pointsEnhanced && Object.keys(trace.pointsEnhanced).length) ? collectPoints(trace?.pointsEnhanced) : [];
  const enhanced = enhancedPoints.length ? buildSkills(enhancedPoints, []).skills : undefined;

  const out: CharacterData = {
    id: String(page.id),
    name: page.name,
    rarity,
    element: elementKo ? (ELEMENT_FROM_KO[elementKo] ?? null) : null,
    element_ko: elementKo,
    path: pathKo ? (PATH_FROM_KO[pathKo] ?? null) : null,
    path_ko: pathKo,
    faction,
    incomplete: incomplete || undefined,
    base_stats_lv80: { ...stats, crit_rate: 5, crit_dmg: 50, source: 'wiki(정수 내림값)' },
    minor_traces: { count: built.minor.length, items: built.minor, totals, unparsed: built.unparsed, source: 'wiki' },
    major_traces: built.major,
    skills: built.skills,
    eidolons,
    eidolon_rank: eidolonRank,
    eidolon_level_bonus_source: 'wiki',
    skill_levels: {},
    enhanced_skills: enhanced,
    warnings,
  };
  recomputeSkillLevels(out);
  return out;
}

export function sumMinor(items: MinorTrace[]): MinorTraceTotals {
  const totals: MinorTraceTotals = {};
  for (const t of items) {
    const slot = (totals[t.stat] ??= {});
    if (t.element) slot.element = t.element;
    if (t.unit === 'pct') slot.pct = r2((slot.pct ?? 0) + t.value, 3);
    else slot.flat = r2((slot.flat ?? 0) + t.value, 3);
  }
  return totals;
}

/** 응답 크기를 줄이기 위한 표현: 선택한 스킬 레벨의 값만 남긴다 */
export function presentCharacter(c: CharacterData, includeLevels = false): any {
  const skills = c.skills.map((s) => {
    const lv = s.level_used ?? s.max_level;
    const rows = (s.rows ?? []).map((r) => {
      const v = r.all?.[Math.max(0, Math.min((r.all?.length ?? 1) - 1, lv - 1))] ?? r.value;
      return includeLevels ? { label: r.label, at_level: v, all: r.all } : { label: r.label, at_level: v };
    });
    return {
      key: s.key,
      kind: s.kind,
      kind_ko: s.kind_ko,
      title: s.title,
      tags: s.tags,
      toughness: s.toughness,
      energy: s.energy,
      level_used: s.level_used,
      max_level: s.max_level || undefined,
      text: s.text,
      values_at_level: rows.length ? rows : undefined,
    };
  });
  return { ...c, skills, enhanced_skills: c.enhanced_skills?.map((s) => ({ key: s.key, kind: s.kind, title: s.title, text: s.text })) };
}
