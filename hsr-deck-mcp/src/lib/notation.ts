// 파티 표기 해석: "은랑Lv.999(풀돌풀재), 에바네시아(1돌전광), 펄(1돌,슈룸모험기)"
//  - 풀돌/만돌/N돌/E N/성혼 N → 성혼(에이돌론) 개방 수
//  - 전광/전용 → 전용 광추, 풀재/N재/S N/N중첩 → 광추 중첩(재련) 단계
//  - 그 밖의 남는 글자 → 광추 이름(약칭 가능)

import { normName } from './util';
import { fv, ListItem } from './wiki';
import { PATH_FROM_KO, PATH_KO } from './stats';
import { SignatureLC, noSignatureReason, signatureFor } from './signature';

export interface Candidate {
  id: string;
  name: string;
  score: number;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function rankMatches(query: string, items: { id: string; name: string }[], limit = 8): Candidate[] {
  const q = normName(query);
  if (!q) return [];
  const out: Candidate[] = [];
  for (const it of items) {
    const n = normName(it.name);
    if (!n) continue;
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 80 + (q.length / n.length) * 10;
    else if (n.includes(q)) score = 60 + (q.length / n.length) * 10;
    else if (n.length >= 2 && q.includes(n)) score = 50 + (n.length / q.length) * 10;
    else {
      const d = dice(q, n);
      if (d >= 0.55) score = 20 + d * 30;
    }
    if (score > 0) out.push({ id: it.id, name: it.name.trim(), score: Math.round(score * 10) / 10 });
  }
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return out.slice(0, limit);
}

/** 1등이 뚜렷하면 확정, 아니면 모호 */
export function pickBest(c: Candidate[]): { best: Candidate | null; ambiguous: boolean } {
  if (!c.length) return { best: null, ambiguous: false };
  if (c[0].score >= 100 && (c[1]?.score ?? 0) < 100) return { best: c[0], ambiguous: false };
  if (c.length === 1) return { best: c[0], ambiguous: c[0].score < 60 };
  if (c[0].score - c[1].score >= 8) return { best: c[0], ambiguous: false };
  return { best: c[0], ambiguous: true };
}

/** 괄호 바깥의 구분자(, / + ; 줄바꿈)로 멤버 분리 */
export function splitPartyText(text: string): string[] {
  const s = String(text ?? '').normalize('NFKC');
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,/+;\n]|、/.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface ParsedOptions {
  eidolon: number | null;
  superimposition: number | null;
  signature: boolean;
  no_lc: boolean;
  lc_text: string;
  matched: string[];
}

export function parseOptions(optText: string): ParsedOptions {
  let s = ' ' + optText.normalize('NFKC') + ' ';
  const matched: string[] = [];
  const res: ParsedOptions = { eidolon: null, superimposition: null, signature: false, no_lc: false, lc_text: '', matched };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      fn(m);
      matched.push(String(m[0]).trim());
      return ' ';
    });
  };

  take(/풀\s*돌|만\s*돌|풀\s*성혼|성혼\s*풀/g, () => (res.eidolon = 6));
  take(/무\s*돌|명\s*함/g, () => (res.eidolon = 0));
  take(/성혼\s*([0-6])|([0-6])\s*성혼/g, (m) => (res.eidolon = Number(m[1] ?? m[2])));
  take(/(?<![a-z0-9])e\s*([0-6])(?![0-9a-z])/gi, (m) => (res.eidolon = Number(m[1])));
  take(/([0-6])\s*돌(?:파)?/g, (m) => (res.eidolon = Number(m[1])));

  take(/풀\s*재(?:련)?|만\s*재(?:련)?|풀\s*중(?:첩)?|풀\s*겹/g, () => (res.superimposition = 5));
  take(/재련\s*([1-5])|중첩\s*([1-5])/g, (m) => (res.superimposition = Number(m[1] ?? m[2])));
  take(/([1-5])\s*재(?:련)?|([1-5])\s*겹|([1-5])\s*중첩?(?![가-힣])/g, (m) => (res.superimposition = Number(m[1] ?? m[2] ?? m[3])));
  take(/(?<![a-z0-9])[sr]\s*([1-5])(?![0-9a-z])/gi, (m) => (res.superimposition = Number(m[1])));

  take(/전용\s*광추|전용|전광|시그니처|시그/g, () => (res.signature = true));
  take(/광추\s*없음|무\s*광|맨\s*몸/g, () => (res.no_lc = true));

  res.lc_text = s.replace(/[,\s·]+/g, ' ').trim();
  return res;
}

export interface ParsedMember {
  raw: string;
  name_text: string;
  options: ParsedOptions;
  hadParens: boolean;
}

/** 이름 / 옵션 분리 (괄호가 없으면 가장 긴 "정확히 일치하는" 접두를 이름으로) */
export function parseMemberToken(raw: string, characters?: { id: string; name: string }[]): ParsedMember {
  const text = raw.normalize('NFKC').trim();
  const paren = [...text.matchAll(/[([{]([^)\]}]*)[)\]}]/g)];
  if (paren.length) {
    const name = text.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim();
    const opt = paren.map((m) => m[1]).join(' ');
    return { raw, name_text: name, options: parseOptions(opt), hadParens: true };
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (characters && words.length > 1) {
    for (let k = words.length; k >= 1; k--) {
      const cand = words.slice(0, k).join(' ');
      const r = rankMatches(cand, characters, 2);
      if (r[0] && r[0].score >= 100) {
        return { raw, name_text: cand, options: parseOptions(words.slice(k).join(' ')), hadParens: false };
      }
    }
  }
  return { raw, name_text: text, options: parseOptions(''), hadParens: false };
}

export interface ResolvedMember {
  raw: string;
  character: { id: string; name: string; rarity: number | null; element_ko: string | null; path: string | null; path_ko: string | null } | null;
  character_candidates?: Candidate[];
  eidolon: number;
  eidolon_source: 'specified' | 'default';
  light_cone: {
    mode: 'signature' | 'named' | 'none' | 'unresolved';
    id?: string;
    name?: string;
    superimposition: number;
    superimposition_source: 'specified' | 'default';
    signature_confidence?: SignatureLC['confidence'];
    candidates?: Candidate[];
    path_match?: boolean | null;
  };
  notes: string[];
}

function charInfo(it: ListItem) {
  const pathKo = fv(it, 'character_paths')[0] ?? null;
  return {
    id: String(it.entry_page_id),
    name: it.name.trim(),
    rarity: Number((fv(it, 'character_rarity')[0] ?? '').replace('★', '')) || null,
    element_ko: fv(it, 'character_combat_type')[0] ?? null,
    path: pathKo ? (PATH_FROM_KO[pathKo] ?? null) : null,
    path_ko: pathKo,
  };
}

export function resolveParty(
  text: string,
  roster: { characters: ListItem[]; lightCones: ListItem[] },
): { members: ResolvedMember[]; warnings: string[] } {
  const chars = roster.characters.map((c) => ({ id: String(c.entry_page_id), name: c.name }));
  const lcs = roster.lightCones.map((c) => ({ id: String(c.entry_page_id), name: c.name }));
  const charById = new Map(roster.characters.map((c) => [String(c.entry_page_id), c]));
  const lcById = new Map(roster.lightCones.map((c) => [String(c.entry_page_id), c]));
  const warnings: string[] = [];
  const members: ResolvedMember[] = [];

  for (const raw of splitPartyText(text)) {
    const pm = parseMemberToken(raw, chars);
    const notes: string[] = [];
    let nameText = pm.name_text;
    const opts = pm.options;

    // "개척자(환락)" → "개척자 • 환락"
    if (/^개척자$/.test(nameText.trim())) {
      const pathTok = Object.values(PATH_KO).find((p) => normName(opts.lc_text).includes(p));
      if (pathTok) {
        nameText = `개척자 • ${pathTok}`;
        opts.lc_text = opts.lc_text.replace(pathTok, '').trim();
      }
    }

    const cands = rankMatches(nameText, chars);
    const { best, ambiguous } = pickBest(cands);
    const m: ResolvedMember = {
      raw,
      character: null,
      eidolon: opts.eidolon ?? 0,
      eidolon_source: opts.eidolon == null ? 'default' : 'specified',
      light_cone: {
        mode: 'unresolved',
        superimposition: opts.superimposition ?? 1,
        superimposition_source: opts.superimposition == null ? 'default' : 'specified',
      },
      notes,
    };
    if (!best) {
      notes.push(`캐릭터 "${nameText}"를 위키 목록에서 찾지 못했습니다.`);
      warnings.push(`"${raw}": 캐릭터를 찾지 못함`);
      members.push(m);
      continue;
    }
    const item = charById.get(best.id)!;
    m.character = charInfo(item);
    if (ambiguous) {
      m.character_candidates = cands.slice(0, 5);
      notes.push(`이름 "${nameText}"이(가) 모호합니다. 후보: ${cands.slice(0, 4).map((c) => `${c.name}(${c.id})`).join(', ')} → "${best.name}"로 가정`);
      warnings.push(`"${raw}": 캐릭터 이름 모호 → ${best.name}`);
    }
    if (/lv\.?\s*999/i.test(m.character.name)) notes.push('"Lv.999"는 캐릭터 이름(은랑 LV.999)의 일부이며 레벨이 아닙니다. 캐릭터 레벨은 항상 80으로 계산합니다.');
    if (opts.eidolon == null) notes.push('성혼 표기가 없어 0돌(E0)로 가정');
    if (opts.eidolon != null && opts.eidolon > 0 && m.character.rarity === 4 && opts.eidolon > 6) notes.push('성혼 범위 초과');

    // 광추 결정
    const lc = m.light_cone;
    if (opts.no_lc) {
      lc.mode = 'none';
      notes.push('광추 없음으로 처리');
    } else if (opts.lc_text) {
      const lcCands = rankMatches(opts.lc_text, lcs);
      const pick = pickBest(lcCands);
      if (pick.best) {
        lc.mode = 'named';
        lc.id = pick.best.id;
        lc.name = pick.best.name;
        if (pick.ambiguous) {
          lc.candidates = lcCands.slice(0, 5);
          notes.push(`광추 "${opts.lc_text}"이(가) 모호합니다. 후보: ${lcCands.slice(0, 4).map((c) => `${c.name}(${c.id})`).join(', ')} → "${pick.best.name}"로 가정`);
          warnings.push(`"${raw}": 광추 이름 모호`);
        }
        const sig = signatureFor(m.character.id);
        if (sig?.some((s) => s.id === lc.id)) notes.push('지정한 광추는 이 캐릭터의 전용 광추입니다.');
        else notes.push('전용 광추가 아닌 광추로 계산합니다(전용 효과가 없음).');
      } else {
        lc.mode = 'unresolved';
        notes.push(`광추 "${opts.lc_text}"를 찾지 못했습니다.`);
        warnings.push(`"${raw}": 광추를 찾지 못함`);
      }
    } else {
      const sig = signatureFor(m.character.id);
      if (sig?.length) {
        lc.mode = 'signature';
        lc.id = sig[0].id;
        lc.name = sig[0].name;
        lc.signature_confidence = sig[0].confidence;
        if (!opts.signature) notes.push('광추 표기가 없어 전용 광추로 가정');
        if (sig[0].confidence === 'probable') notes.push('전용 광추 매핑이 "추정" 수준입니다. 확인이 필요합니다.');
      } else {
        lc.mode = 'unresolved';
        const why = noSignatureReason(m.character.id);
        notes.push(opts.signature ? `전용 광추 정보가 없습니다${why ? `(${why})` : ''}. 같은 운명의 길 광추 중 선택이 필요합니다.` : `광추 표기가 없고 전용 광추 정보도 없습니다${why ? `(${why})` : ''}.`);
        warnings.push(`"${raw}": 광추 미정`);
      }
    }
    if (lc.superimposition_source === 'default') notes.push('중첩 표기가 없어 1재(S1)로 가정');

    // 운명의 길 일치 확인
    if (lc.id) {
      const lcItem = lcById.get(lc.id);
      const lcPathKo = lcItem ? (fv(lcItem, 'equipment_paths')[0] ?? null) : null;
      lc.path_match = lcPathKo && m.character.path_ko ? lcPathKo === m.character.path_ko : null;
      if (lc.path_match === false) {
        notes.push(`광추 운명의 길(${lcPathKo})이 캐릭터(${m.character.path_ko})와 달라 패시브가 발동하지 않습니다(기초 능력치만 적용).`);
        warnings.push(`"${raw}": 광추-캐릭터 운명의 길 불일치`);
      }
    }
    members.push(m);
  }
  if (members.length === 0) warnings.push('파티 표기에서 멤버를 찾지 못했습니다.');
  return { members, warnings };
}
