// 유물 규칙·상수 (★5, +15 기준).
// 값의 출처: Mar-7th/StarRailRes relic_main_affixes / relic_sub_affixes (5성, base + step × 레벨).

export const SLOTS = ['head', 'hands', 'body', 'feet', 'sphere', 'rope'] as const;
export type Slot = (typeof SLOTS)[number];

export const SLOT_KO: Record<Slot, string> = {
  head: '머리',
  hands: '손',
  body: '몸통',
  feet: '발',
  sphere: '연결 구체',
  rope: '연결 끈',
};

/** 부위별 선택 가능한 주옵션 (구체의 속성 피해는 elemental_dmg 하나로 표기) */
export const MAIN_OPTIONS: Record<Slot, string[]> = {
  head: ['hp'],
  hands: ['atk'],
  body: ['hp_pct', 'atk_pct', 'def_pct', 'crit_rate', 'crit_dmg', 'outgoing_healing', 'effect_hit'],
  feet: ['hp_pct', 'atk_pct', 'def_pct', 'spd'],
  sphere: ['hp_pct', 'atk_pct', 'def_pct', 'elemental_dmg'],
  rope: ['break_effect', 'energy_regen', 'hp_pct', 'atk_pct', 'def_pct'],
};

/** 주옵션 +15 값. unit: 고정값(flat) 또는 퍼센트 포인트(pct) */
export const MAIN_VALUE: Record<string, { value: number; unit: 'flat' | 'pct'; stat: string }> = {
  hp: { value: 705.6, unit: 'flat', stat: 'hp' },
  atk: { value: 352.8, unit: 'flat', stat: 'atk' },
  hp_pct: { value: 43.2, unit: 'pct', stat: 'hp' },
  atk_pct: { value: 43.2, unit: 'pct', stat: 'atk' },
  def_pct: { value: 54.0, unit: 'pct', stat: 'def' },
  crit_rate: { value: 32.4, unit: 'pct', stat: 'crit_rate' },
  crit_dmg: { value: 64.8, unit: 'pct', stat: 'crit_dmg' },
  outgoing_healing: { value: 34.561, unit: 'pct', stat: 'outgoing_healing' },
  effect_hit: { value: 43.2, unit: 'pct', stat: 'effect_hit' },
  spd: { value: 25.032, unit: 'flat', stat: 'spd' },
  elemental_dmg: { value: 38.88, unit: 'pct', stat: 'elemental_dmg' },
  break_effect: { value: 64.8, unit: 'pct', stat: 'break_effect' },
  energy_regen: { value: 19.439, unit: 'pct', stat: 'energy_regen' },
};

export const SUB_KEYS = [
  'hp',
  'atk',
  'def',
  'hp_pct',
  'atk_pct',
  'def_pct',
  'spd',
  'crit_rate',
  'crit_dmg',
  'effect_hit',
  'effect_res',
  'break_effect',
] as const;
export type SubKey = (typeof SUB_KEYS)[number];

/** 부옵션 1회 롤: 하(base) / 중(base+step) / 상(base+2·step) */
export const SUB_ROLL: Record<SubKey, { base: number; step: number; unit: 'flat' | 'pct'; stat: string }> = {
  hp: { base: 33.87004, step: 4.233755, unit: 'flat', stat: 'hp' },
  atk: { base: 16.935019, step: 2.116877, unit: 'flat', stat: 'atk' },
  def: { base: 16.935019, step: 2.116877, unit: 'flat', stat: 'def' },
  hp_pct: { base: 3.4560002, step: 0.43200003, unit: 'pct', stat: 'hp' },
  atk_pct: { base: 3.4560002, step: 0.43200003, unit: 'pct', stat: 'atk' },
  def_pct: { base: 4.32, step: 0.54, unit: 'pct', stat: 'def' },
  spd: { base: 2.0, step: 0.3, unit: 'flat', stat: 'spd' },
  crit_rate: { base: 2.592, step: 0.324, unit: 'pct', stat: 'crit_rate' },
  crit_dmg: { base: 5.184, step: 0.648, unit: 'pct', stat: 'crit_dmg' },
  effect_hit: { base: 3.456, step: 0.432, unit: 'pct', stat: 'effect_hit' },
  effect_res: { base: 3.456, step: 0.432, unit: 'pct', stat: 'effect_res' },
  break_effect: { base: 5.184, step: 0.648, unit: 'pct', stat: 'break_effect' },
};

export type Quality = 'low' | 'avg' | 'high';
export const QUALITY_MULT: Record<Quality, number> = { low: 0, avg: 1, high: 2 };

export function subRollValue(sub: SubKey, q: Quality = 'avg'): number {
  const r = SUB_ROLL[sub];
  return r.base + r.step * QUALITY_MULT[q];
}

export const SUB_KO: Record<string, string> = {
  hp: 'HP(고정)',
  atk: '공격력(고정)',
  def: '방어력(고정)',
  hp_pct: 'HP%',
  atk_pct: '공격력%',
  def_pct: '방어력%',
  spd: '속도',
  crit_rate: '치명타 확률',
  crit_dmg: '치명타 피해',
  effect_hit: '효과 명중',
  effect_res: '효과 저항',
  break_effect: '격파 특수효과',
};

export const MAIN_KO: Record<string, string> = {
  ...SUB_KO,
  outgoing_healing: '치유량 보너스',
  elemental_dmg: '속성 피해 보너스',
  energy_regen: '에너지 충전 효율',
};

/** 부위 기본 규칙 */
export const RELIC_RULES = {
  rarity: 5,
  level: 15,
  max_total_rolls: { four_start_substats: 9, three_start_substats: 8 },
  notes: [
    '5성 유물 +15 기준. 4개의 부옵션은 서로 달라야 하며 주옵션과 같은 종류는 부옵션이 될 수 없다.',
    '초기 부옵션이 4개인 부품은 총 9회(초기 4 + 강화 5), 3개인 부품은 총 8회(초기 3 + 새 옵션 1 + 강화 4)의 롤을 가진다.',
    '한 부옵션에 몰릴 수 있는 롤은 부품당 최대 6회(초기 1 + 강화 5).',
    '부옵션 1롤 값은 하/중/상 = base, base+step, base+2·step 이며 평균(중) 값으로 계획한다.',
    '머리는 HP(고정), 손은 공격력(고정)이 주옵션으로 고정이다.',
    '머리·손·몸통·발은 동굴 유물(4세트 가능) 세트, 연결 구체·연결 끈은 차원 장신구(2세트) 세트의 부품이다.',
  ],
};

export function mainValue(main: string): { value: number; unit: 'flat' | 'pct'; stat: string } {
  const v = MAIN_VALUE[main];
  if (!v) throw new Error(`알 수 없는 주옵션: ${main}`);
  return v;
}

export function rollsCap(start: 3 | 4): number {
  return start === 4 ? 9 : 8;
}
