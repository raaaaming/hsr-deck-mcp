// 스탯 어휘(한국어 ↔ 내부 키)와 위키 텍스트에서 스탯 증가 문장을 뽑아내는 도우미

export type StatKey =
  | 'hp'
  | 'atk'
  | 'def'
  | 'spd'
  | 'crit_rate'
  | 'crit_dmg'
  | 'break_effect'
  | 'effect_hit'
  | 'effect_res'
  | 'energy_regen'
  | 'outgoing_healing'
  | 'elemental_dmg'
  | 'elation';

export const STAT_KO: Record<string, string> = {
  hp: 'HP',
  atk: '공격력',
  def: '방어력',
  spd: '속도',
  crit_rate: '치명타 확률',
  crit_dmg: '치명타 피해',
  break_effect: '격파 특수효과',
  effect_hit: '효과 명중',
  effect_res: '효과 저항',
  energy_regen: '에너지 충전 효율',
  outgoing_healing: '치유량 보너스',
  elemental_dmg: '속성 피해 보너스',
  elation: '환락도',
};

export const ELEMENT_KO: Record<string, string> = {
  Physical: '물리',
  Fire: '화염',
  Ice: '얼음',
  Thunder: '번개',
  Lightning: '번개',
  Wind: '바람',
  Quantum: '양자',
  Imaginary: '허수',
};
export const ELEMENT_FROM_KO: Record<string, string> = Object.fromEntries(
  Object.entries(ELEMENT_KO).map(([k, v]) => [v, k === 'Lightning' ? 'Thunder' : k]),
);

export const PATH_KO: Record<string, string> = {
  Warrior: '파멸',
  Rogue: '수렵',
  Mage: '지식',
  Shaman: '화합',
  Warlock: '공허',
  Knight: '보존',
  Priest: '풍요',
  Memory: '기억',
  Elation: '환락',
};
export const PATH_FROM_KO: Record<string, string> = Object.fromEntries(Object.entries(PATH_KO).map(([k, v]) => [v, k]));

const ELEM_RE = '(?:물리|화염|얼음|번개|바람|양자|허수)';

/** 우선순위 순서. 앞쪽이 먼저 매칭된다. */
const LABELS: { re: RegExp; stat: StatKey }[] = [
  { re: /치명타\s*확률/, stat: 'crit_rate' },
  { re: /치명타\s*피해/, stat: 'crit_dmg' },
  { re: /격파\s*특수\s*효과/, stat: 'break_effect' },
  { re: /효과\s*명중/, stat: 'effect_hit' },
  { re: /효과\s*저항/, stat: 'effect_res' },
  { re: /에너지\s*(?:충전|회복)\s*효율/, stat: 'energy_regen' },
  { re: /(?:치유량|치료량)(?:\s*보너스)?/, stat: 'outgoing_healing' },
  { re: new RegExp(`${ELEM_RE}\\s*속성\\s*피해`), stat: 'elemental_dmg' },
  { re: /환락도/, stat: 'elation' },
  { re: /속도/, stat: 'spd' },
  { re: /방어력/, stat: 'def' },
  { re: /공격력/, stat: 'atk' },
  { re: /(?:최대\s*)?HP|생명력/i, stat: 'hp' },
];

export function matchLabel(text: string): { stat: StatKey; index: number; end: number; element?: string } | null {
  let best: { stat: StatKey; index: number; end: number; element?: string } | null = null;
  for (const { re, stat } of LABELS) {
    const m = re.exec(text);
    if (!m) continue;
    if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.end - best.index)) {
      const el = stat === 'elemental_dmg' ? ELEMENT_FROM_KO[m[0].slice(0, 2)] : undefined;
      best = { stat, index: m.index, end: m.index + m[0].length, element: el };
    }
  }
  return best;
}

export interface TraceStat {
  stat: StatKey;
  value: number;
  unit: 'pct' | 'flat';
  element?: string;
}

/** 작은 행적 한 줄("방어력 5.0% 증가", "속도 2 증가", "얼음 속성 피해 8% 증가")을 해석 */
export function parseStatPhrase(raw: string): TraceStat | null {
  const text = raw.replace(/\s+/g, ' ').replace(/%+/g, '%').trim();
  const label = matchLabel(text);
  if (!label) return null;
  const nums = [...text.matchAll(/(\d[\d,]*\.?\d*)\s*(%)?/g)];
  if (!nums.length) return null;
  // 라벨 뒤쪽에 있는 첫 숫자를 우선
  const after = nums.find((n) => (n.index ?? 0) >= label.end - 1) ?? nums[nums.length - 1];
  const value = parseFloat(after[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const pct = !!after[2];
  const base: StatKey = label.stat;
  const unit: 'pct' | 'flat' = pct ? 'pct' : base === 'hp' || base === 'atk' || base === 'def' || base === 'spd' ? 'flat' : 'pct';
  return { stat: base, value, unit, element: label.element };
}

export interface StatHint {
  stat: StatKey;
  value: number;
  unit: 'pct' | 'flat';
  element?: string;
  scope: 'self' | 'team' | 'unknown';
  conditional: boolean;
  condition?: string;
  sentence: string;
}

const COND_RE = /(시[,\s.]|할 때|일 때|경우|동안|턴|후에|이상일|이하일|보유|발동|사용 시|공격 시|획득|중첩|\d+회|이상이면|이하이면|넘으면|초과)/;

/**
 * 평문에서 "OO이/가 N% 증가" 형태의 문장을 휴리스틱으로 추출한다.
 * 결과는 후보일 뿐이며, 조건·대상은 반드시 원문으로 다시 확인해야 한다.
 */
export function extractStatHints(text: string, defaultScope: 'self' | 'unknown' = 'unknown'): StatHint[] {
  const hints: StatHint[] = [];
  if (!text) return hints;
  const sentences = text
    .split(/\n+|(?<=[.。])\s+(?=[^\d])/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sent of sentences) {
    const re = /(\d[\d,]*\.?\d*)\s*(%|pt)?\s*(?:만큼\s*)?(?:추가로\s*)?(증가|상승)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sent))) {
      const before = sent.slice(Math.max(0, m.index - 22), m.index);
      // 가장 가까운(오른쪽) 라벨을 선택
      let found: ReturnType<typeof matchLabel> = null;
      let foundEnd = -1;
      for (const { re: lre } of LABELS) {
        const g = new RegExp(lre.source, 'g' + (lre.flags.includes('i') ? 'i' : ''));
        let x: RegExpExecArray | null;
        while ((x = g.exec(before))) {
          const end = x.index + x[0].length;
          if (end > foundEnd) {
            foundEnd = end;
            found = matchLabel(x[0]);
          }
        }
      }
      if (!found) continue;
      const between = before.slice(foundEnd);
      if (/[,，]/.test(between) || between.length > 12) continue;
      // "방어력 무시", "저항 관통" 같은 라벨 뒤 수식어 제외
      if (/무시|관통|감소|저항 관통/.test(between)) continue;
      const value = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      const pct = m[2] === '%';
      const base = found.stat;
      const unit: 'pct' | 'flat' = pct ? 'pct' : base === 'hp' || base === 'atk' || base === 'def' || base === 'spd' ? 'flat' : 'pct';
      const team = /모든 아군|아군 전체|파티 내 모든|아군의/.test(sent) && !/장착한 캐릭터의|자신의/.test(sent);
      const self = /장착한 캐릭터|자신/.test(sent);
      const cm = COND_RE.exec(sent);
      hints.push({
        stat: base,
        value,
        unit,
        element: found.element,
        scope: team ? 'team' : self ? 'self' : defaultScope,
        conditional: !!cm,
        condition: cm ? cm[0].trim() : undefined,
        sentence: sent.length > 160 ? sent.slice(0, 157) + '…' : sent,
      });
    }
  }
  return hints;
}
