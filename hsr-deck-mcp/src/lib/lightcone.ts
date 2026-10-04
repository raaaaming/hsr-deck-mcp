// 광추 / 유물 세트 정규화 (목록 API의 display_field만으로 충분히 구성 가능)

import { component, EntryPage, ListItem, fv } from './wiki';
import { htmlToText } from './html';
import { StatHint, PATH_FROM_KO, extractStatHints } from './stats';
import { toNum } from './util';

export interface LightConeData {
  id: string;
  name: string;
  rarity: number | null;
  path: string | null;
  path_ko: string | null;
  source?: string;
  passive_name: string;
  passive_text: string;
  superimposition: number;
  base_stats_lv80: { hp: number | null; atk: number | null; def: number | null; source: string };
  stat_hints: StatHint[];
  signature_of?: string[];
  /** 파싱 중 발견한 문제(중첩 수치가 5단계로 표기되지 않음 등) */
  notes?: string[];
}

const SEQ5 = /\d+(?:\.\d+)?%?(?:\/\d+(?:\.\d+)?%?){4}/g;

/** "12%/14%/16%/18%/20%" 같은 5단계 값을 지정한 중첩 단계(1~5)로 치환 */
export function renderSuperimposition(text: string, s: number): string {
  const idx = Math.max(1, Math.min(5, Math.round(s))) - 1;
  return text.replace(SEQ5, (m) => {
    const parts = m.split('/');
    let v = parts[idx];
    const last = parts[parts.length - 1];
    if (last.endsWith('%') && !v.endsWith('%')) v += '%';
    return v;
  });
}

export function rankValueSequences(text: string): string[] {
  return text.match(SEQ5) ?? [];
}

function splitPassive(html: string): { name: string; body: string } {
  const i = html.indexOf('<');
  if (i <= 0) return { name: '', body: htmlToText(html) };
  return { name: htmlToText(html.slice(0, i)), body: htmlToText(html.slice(i)) };
}

function parseAttr80(json: unknown): { hp: number | null; atk: number | null; def: number | null } | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const o = JSON.parse(json);
    return { hp: toNum(o.base_hp), atk: toNum(o.base_atk), def: toNum(o.base_def) };
  } catch {
    return null;
  }
}

export function lcBaseFromEntry(page: EntryPage): { hp: number | null; atk: number | null; def: number | null } | null {
  const asc = component<{ list: { key: string; combatList: { key: string; values: string[] }[] }[] }>(page, 'ascension');
  // "Lv. 80", "Lv.80", 오기된 "Lv.. 80" 모두 허용
  const lv80 = asc?.list?.find((e) => /^lv\W*80$/i.test(String(e.key).trim()));
  if (!lv80) return null;
  const val = (row: { values: string[] }) => toNum(row.values?.[0]) ?? toNum(row.values?.[1]);
  const rows = (lv80.combatList ?? []).filter((c) => /^기초/.test(String(c.key).trim()));
  const byLabel = (re: RegExp) => {
    const row = rows.find((c) => re.test(c.key));
    return row ? val(row) : null;
  };
  const labelled = { hp: byLabel(/HP/i), atk: byLabel(/공격력/), def: byLabel(/방어력/) };
  // 위키 입력 오기(방어력 행에 "기초 공격력" 라벨이 중복 등) 대비: 기초 행이 3개이고 라벨이 겹치면 HP·공격력·방어력 순서로 읽는다
  const labels = rows.map((c) => String(c.key).trim());
  if (rows.length === 3 && new Set(labels).size < 3) return { hp: val(rows[0]), atk: val(rows[1]), def: val(rows[2]) };
  return labelled;
}

/** 목록 응답의 기초 능력치가 하나라도 비어 있으면 상세 페이지로 보완해야 한다 */
export function lcBaseIncomplete(lc: LightConeData): boolean {
  const b = lc.base_stats_lv80;
  return b.hp == null || b.atk == null || b.def == null;
}

export function normalizeLightCone(item: ListItem, superimposition = 1): LightConeData {
  const df = item.display_field ?? {};
  const { name: passiveName, body } = splitPassive(String(df.equipment_skill ?? ''));
  const rendered = renderSuperimposition(body, superimposition);
  const a80 = parseAttr80(df.attr_level_80);
  const pathKo = fv(item, 'equipment_paths')[0] ?? null;
  const notes: string[] = [];
  if (/\d\s*\/\s*\d/.test(rendered)) notes.push('패시브 수치가 5단계(a/b/c/d/e)로 표기되지 않은 부분이 있어 중첩 단계를 반영하지 못했습니다. 원문을 확인하세요.');
  return {
    id: String(item.entry_page_id),
    name: item.name,
    rarity: toNum(fv(item, 'equipment_rarity')[0]?.replace('★', '')),
    path: pathKo ? (PATH_FROM_KO[pathKo] ?? null) : null,
    path_ko: pathKo,
    source: fv(item, 'equipment_source')[0],
    passive_name: passiveName,
    passive_text: rendered,
    superimposition,
    base_stats_lv80: { hp: a80?.hp ?? null, atk: a80?.atk ?? null, def: a80?.def ?? null, source: 'wiki(정수 내림값)' },
    stat_hints: extractStatHints(rendered, 'self'),
    notes: notes.length ? notes : undefined,
  };
}

export interface RelicSetData {
  id: string;
  name: string;
  type: 'cavern' | 'planar';
  type_ko: string;
  two_piece: string;
  four_piece: string | null;
  two_piece_hints: StatHint[];
  four_piece_hints: StatHint[];
  tags: string[];
}

export function normalizeRelicSet(item: ListItem): RelicSetData {
  const df = item.display_field ?? {};
  const two = htmlToText(df.two_set_effect ?? '');
  const four = htmlToText(df.four_set_effect ?? '');
  const single = htmlToText(df.single_set_effect ?? '');
  const setTag = fv(item, 'relic_set')[0] ?? '';
  const planar = /^2/.test(setTag) || (!four && !!two);
  const twoText = two || single;
  return {
    id: String(item.entry_page_id),
    name: item.name,
    type: planar ? 'planar' : 'cavern',
    type_ko: planar ? '차원 장신구(연결 구체·연결 끈)' : '동굴 유물(머리·손·몸통·발)',
    two_piece: twoText,
    four_piece: planar ? null : four || null,
    two_piece_hints: extractStatHints(twoText, 'self'),
    four_piece_hints: planar ? [] : extractStatHints(four, 'self'),
    tags: fv(item, 'relic_skill_type'),
  };
}
