// 테스트용 위키 항목 조립 도우미 (실제 위키 응답의 모양을 본떠서 만든다)
import type { EntryPage } from '../src/lib/wiki';

export const hdr = (h: string) => `<p><strong><span style="color: rgb(255, 255, 255)">&lt;${h}&gt;</span></strong></p><p></p>`;
export const para = (t: string) => `<p>${t}</p>`;

/** 스킬 레벨 표: 머리행 + 값 행들 + 승급 재료 행 */
export function skillForm(rows: [string, string[]][], levels: number, head = '행적 레벨', trailingEmptyHead = false): string {
  const th = Array.from({ length: levels }, (_, i) => `<td><p>레벨 ${i + 1}</p></td>`).join('') + (trailingEmptyHead ? '<td><p></p></td>' : '');
  const body = rows.map(([label, vals]) => `<tr><td><p>${label}</p></td>${vals.map((v) => `<td><p>${v}</p></td>`).join('')}</tr>`).join('');
  return `<table><tbody><tr><td><p>${head}</p></td>${th}</tr>${body}<tr><td><p>승급 재료</p></td><td><p>재료</p></td></tr></tbody></table>`;
}

/** 작은/큰 행적의 표: 레벨 1짜리 */
export function minorForm(trailingEmptyHead = false): string {
  return skillForm([], 1, '행적 레벨', trailingEmptyHead);
}

export interface PointSpec {
  title: string;
  /** 꺾쇠 머리글 이름(예: "필살기"). null이면 머리글 없음 */
  header?: string | null;
  /** 꺾쇠 없는 평문 머리글(예: 사이퍼) */
  plain?: string;
  lines: string[];
  form?: string;
}

export function point(s: PointSpec) {
  let desc = '';
  if (s.header) desc += hdr(s.header);
  if (s.plain) desc += para(s.plain);
  desc += s.lines.map(para).join('');
  return { icon: '', img: '', title: s.title, desc, form: s.form ?? '' };
}

const seq = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));

/** 10레벨(또는 지정 수) 스킬 점 */
export function skillPoint(title: string, header: string | null, tag: string, levels: number, opts: { plain?: boolean; trailingEmptyHead?: boolean; extra?: string[] } = {}) {
  return point({
    title,
    header: opts.plain ? undefined : header,
    plain: opts.plain && header ? header : undefined,
    lines: [tag, ...(opts.extra ?? ['지정된 단일 적에게 공격력의 100%만큼 피해를 준다'])],
    form: skillForm([['피해', seq(levels, (i) => `${50 + i * 10}%`)]], levels, '행적 레벨', opts.trailingEmptyHead),
  });
}

export const minorPoint = (title: string, text: string, header: string | null = '속성 보너스') =>
  point({ title, header, lines: [text], form: minorForm() });

export interface PageSpec {
  id?: string;
  name: string;
  rarity?: string;
  element?: string;
  path?: string;
  points?: Record<string, ReturnType<typeof point>>;
  asc80?: { key?: string; hp?: string; atk?: string; def?: string; spd?: string } | null;
  eidolons?: { name: string; desc: string }[];
  noTrace?: boolean;
}

export function makePage(s: PageSpec): EntryPage {
  const comps: { component_id: string; data: string }[] = [];
  if (!s.noTrace) comps.push({ component_id: 'trace', data: JSON.stringify({ points: s.points ?? standardPoints() }) });
  if (s.asc80 !== null) {
    const a = s.asc80 ?? {};
    comps.push({
      component_id: 'ascension',
      data: JSON.stringify({
        list: [
          { key: 'Lv. 1', combatList: [{ key: '', values: ['돌파 전', '돌파 후'] }, { key: '기초 HP', values: ['100', '-'] }] },
          {
            key: a.key ?? 'Lv. 80',
            combatList: [
              { key: '', values: ['돌파 전', '돌파 후'] },
              { key: '기초 HP', values: [a.hp ?? '1397', '-'] },
              { key: '기초 공격력', values: [a.atk ?? '523', '-'] },
              { key: '기초 방어력', values: [a.def ?? '485', '-'] },
              { key: '기초 속도', values: [a.spd ?? '101', '-'] },
            ],
          },
        ],
      }),
    });
  }
  const eid = s.eidolons ?? Array.from({ length: 6 }, (_, i) => ({ name: `E${i + 1}`, desc: `<p>성혼 ${i + 1} 효과</p>` }));
  comps.push({ component_id: 'summaryList', data: JSON.stringify({ list: eid }) });
  const filter = (v: string | undefined) => (v ? { values: [v] } : undefined);
  return {
    id: s.id ?? '9999',
    name: s.name,
    filter_values: {
      ...(s.rarity ? { character_rarity: filter(s.rarity)! } : { character_rarity: { values: ['★5'] } }),
      character_combat_type: filter(s.element ?? '양자')!,
      character_paths: filter(s.path ?? '공허')!,
    },
    modules: [{ name: 'all', components: comps }],
  };
}

/** 표준적인 10 + 3 행적 구성 (P키 방식) */
export function standardPoints(): Record<string, ReturnType<typeof point>> {
  const p: Record<string, ReturnType<typeof point>> = {
    P01: skillPoint('평타', '일반 공격', '[단일 공격] | 강인성 감소 수치: 10', 6),
    P02: skillPoint('스킬', '전투 스킬', '[단일 공격] | 강인성 감소 수치: 20', 10),
    P03: skillPoint('필살', '필살기', '[범위 공격] | 에너지 소모 120 | 강인성 감소 수치: 20', 10),
    P04: skillPoint('특성', '특성', '[강화]', 10),
    P05: point({ title: '비술', header: '비술', lines: ['비술 사용 후 전투 시작 시 적을 공격한다'] }),
    P06: point({ title: '추가1', header: '추가 능력', lines: ['치명타 피해가 20% 증가한다. 필살기 사용 시 공격력이 24% 증가한다'], form: minorForm() }),
    P07: point({ title: '추가2', header: '추가 능력', lines: ['전투 스킬 사용 시 아군 전체 속도가 10% 증가한다. 지속 시간 2턴'], form: minorForm() }),
    P08: point({ title: '추가3', header: '추가 능력', lines: ['적을 처치하면 에너지를 10pt 회복한다. 최대 3회'], form: minorForm() }),
  };
  const minors: [string, string][] = [
    ['공격 강화', '공격력 4.0% 증가'],
    ['공격 강화', '공격력 6.0% 증가'],
    ['공격 강화', '공격력 8.0% 증가'],
    ['치명타 확률 강화', '치명타 확률 2.7% 증가'],
    ['치명타 확률 강화', '치명타 확률 4.0% 증가'],
    ['속도 강화', '속도 2 증가'],
    ['속도 강화', '속도 3 증가'],
    ['피해 강화•양자', '양자 속성 피해 3.2% 증가'],
    ['피해 강화•양자', '양자 속성 피해 4.8% 증가'],
    ['방어 강화', '방어력 5.0% 증가'],
  ];
  minors.forEach(([t, x], i) => (p[`P${String(9 + i).padStart(2, '0')}`] = minorPoint(t, x)));
  return p;
}
