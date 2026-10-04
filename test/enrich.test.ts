// StarRailRes 보강(성혼 스킬 레벨 보너스 대조)을 합성 데이터로 검증한다. 실제 데이터에서 겪은 사례를 그대로 본떴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCharacter } from '../src/lib/character';
import { SrrData, enrichCharacter, reconcileLevelBonuses, srrLevelBonuses } from '../src/lib/enrich';
import { normName } from '../src/lib/util';
import { makePage, skillPoint, standardPoints } from './helpers';

type Skills = Record<string, { name: string; type: string }>;
type Ranks = Record<string, { level_up_skills?: { id: string; num: number }[] }>;

function srrWith(o: { chars?: Record<string, any>; ranks?: Ranks | null; skills?: Skills | null }): SrrData {
  const chars = o.chars ?? {};
  const byCharName = new Map<string, any[]>();
  for (const v of Object.values(chars)) {
    const k = normName(v.name);
    byCharName.set(k, [...(byCharName.get(k) ?? []), v]);
  }
  return { chars, promos: {}, lcs: {}, lcPromos: {}, trees: null, ranks: o.ranks ?? null, skills: o.skills ?? null, byCharName, byLcName: new Map() };
}

const ups = (...u: [string, number][]) => ({ level_up_skills: u.map(([id, num]) => ({ id, num })) });

// ── 효광(환락): E3 "스킬 레벨+1"이 사실은 환락 스킬 ──
const XG_SKILLS: Skills = {
  '150201': { name: '공작의 명적', type: 'Normal' },
  '150202': { name: '십방광영', type: 'BPSkill' },
  '150203': { name: '무지개를 두른 강철 깃', type: 'Ultra' },
  '150204': { name: '세상을 관통하는 천 개의 눈', type: 'Talent' },
  '150206': { name: '공격', type: 'MazeNormal' },
  '150220': { name: '그대에게 주는 점괘', type: 'ElationDamage' },
};
const XG_RANKS: Ranks = {
  '150201': ups(),
  '150202': ups(),
  '150203': ups(['150202', 2], ['150201', 1], ['150220', 1]),
  '150204': ups(),
  '150205': ups(['150203', 2], ['150204', 2], ['150220', 1]),
  '150206': ups(),
};
const XG_HIT = { id: '1502', name: '효광', path: 'Elation', element: 'Physical', ranks: ['150201', '150202', '150203', '150204', '150205', '150206'] };
const xgSrr = () => srrWith({ chars: { '1502': XG_HIT }, ranks: XG_RANKS, skills: XG_SKILLS });

function xgPage(rank: number, e3: string) {
  const pts = {
    ...standardPoints(),
    P01: skillPoint('평타', '일반 공격', '[단일 공격] | 강인성 감소 수치: 10', 10),
    P02: skillPoint('스킬', '전투 스킬', '[강화]', 15),
    P03: skillPoint('필살', '필살기', '[강화] | 에너지 소모 150', 15),
    P04: skillPoint('특성', '특성', '[강화]', 15),
    P22: skillPoint('환락', '환락 스킬', '[범위 공격]', 15),
  };
  const eidolons = Array.from({ length: 6 }, (_, i) => ({
    name: `E${i + 1}`,
    desc: `<p>${i === 2 ? e3 : i === 4 ? '필살기 레벨+2, 최대 Lv15. 특성 레벨+2, 최대 Lv.10. 환락 스킬 레벨+1, 최대 Lv.15' : '효과'}</p>`,
  }));
  return normalizeCharacter(makePage({ name: '효광', path: '환락', element: '물리', points: pts, eidolons }), undefined, { eidolon: rank });
}
const levelOf = (c: ReturnType<typeof xgPage>, kind: string) => c.skills.find((s) => s.kind === kind)?.level_used;

const XG_TYPO = '전투 스킬 레벨+2, 최대 Lv15. 일반 공격 레벨+1, 최대 Lv.10. 스킬 레벨+1, 최대 Lv.15';
const XG_FIXED = '전투 스킬 레벨+2, 최대 Lv15. 일반 공격 레벨+1, 최대 Lv.10. 환락 스킬 레벨+1, 최대 Lv.15';

test('성혼 레벨 보정: 위키 오기("스킬 레벨+1")를 게임 데이터로 바로잡아 환락 스킬이 Lv.12가 된다 (효광)', () => {
  const c = xgPage(6, XG_TYPO);
  assert.equal(levelOf(c, 'elation_skill'), 11, '보정 전에는 위키 오기 때문에 한 단계 모자라다');
  enrichCharacter(c, xgSrr());
  assert.equal(levelOf(c, 'elation_skill'), 12);
  assert.equal(levelOf(c, 'skill'), 12);
  assert.equal(levelOf(c, 'ultimate'), 12);
  assert.equal(levelOf(c, 'talent'), 12);
  assert.equal(levelOf(c, 'basic'), 7);
  assert.equal(c.eidolon_level_bonus_source, 'StarRailRes(위키 설명 불일치 보정)');
  assert.ok(c.warnings.some((w) => w.includes('성혼 스킬 레벨 보너스') && w.includes('환락 스킬')), c.warnings.join('|'));
  assert.deepEqual(c.eidolons[2].level_bonus, { basic: 1, skill: 2, elation_skill: 1 });
});

test('성혼 레벨 보정: 성혼 수에 맞게 단계별로 오른다 (E0/E3/E5)', () => {
  const at = (rank: number) => {
    const c = xgPage(rank, XG_TYPO);
    enrichCharacter(c, xgSrr());
    return [levelOf(c, 'basic'), levelOf(c, 'skill'), levelOf(c, 'ultimate'), levelOf(c, 'talent'), levelOf(c, 'elation_skill')];
  };
  assert.deepEqual(at(0), [6, 10, 10, 10, 10]);
  assert.deepEqual(at(2), [6, 10, 10, 10, 10]);
  assert.deepEqual(at(3), [7, 12, 10, 10, 11]);
  assert.deepEqual(at(4), [7, 12, 10, 10, 11]);
  assert.deepEqual(at(5), [7, 12, 12, 12, 12]);
});

test('성혼 레벨 보정: 위키 설명이 맞으면 그대로 두고 일치 확인만 표시', () => {
  const c = xgPage(6, XG_FIXED);
  enrichCharacter(c, xgSrr());
  assert.equal(levelOf(c, 'elation_skill'), 12);
  assert.equal(c.eidolon_level_bonus_source, 'wiki + StarRailRes 일치 확인');
  assert.ok(!c.warnings.some((w) => w.includes('성혼 스킬 레벨 보너스')));
});

test('성혼 레벨 보정: 게임 데이터(ranks/skills)가 없으면 위키 값을 그대로 쓴다', () => {
  const c = xgPage(6, XG_TYPO);
  enrichCharacter(c, srrWith({ chars: { '1502': XG_HIT }, ranks: null, skills: null }));
  assert.equal(levelOf(c, 'elation_skill'), 11);
  assert.equal(c.eidolon_level_bonus_source, 'wiki');
});

test('성혼 레벨 보정: 표가 짧아 생기는 안내 문구는 다시 계산해도 중복되지 않는다', () => {
  // 전투 스킬 표가 Lv.10까지만 수록 → E3+E5 보너스를 못 담는다는 안내가 정확히 한 번만 남는다
  const pts = { ...standardPoints(), P22: skillPoint('환락', '환락 스킬', '[범위 공격]', 15) };
  const c = normalizeCharacter(makePage({ name: '효광', path: '환락', element: '물리', points: pts, eidolons: Array.from({ length: 6 }, (_, i) => ({ name: `E${i}`, desc: `<p>${i === 2 ? XG_TYPO : '효과'}</p>` })) }), undefined, { eidolon: 6 });
  const before = c.warnings.filter((w) => w.includes('위키 표가')).length;
  enrichCharacter(c, xgSrr());
  const after = c.warnings.filter((w) => w.includes('위키 표가')).length;
  assert.ok(after >= 1);
  assert.equal(after, c.warnings.filter((w, i, a) => w.includes('위키 표가') && a.indexOf(w) === i).length, '같은 안내가 두 번 들어가면 안 된다');
  assert.ok(before >= 1);
});

// ── srrLevelBonuses: 실제 데이터의 변칙 ──

test('srrLevelBonuses: 한 스킬이 여러 id(강화판·변형)로 쪼개져 있어도 한 번만 오른 것으로 센다 (펄, 키레네)', () => {
  const skills: Skills = {
    '1': { name: '평타', type: 'Normal' },
    '2': { name: '평타(강화)', type: 'Normal' },
    '3': { name: '평타(강화2)', type: 'Normal' },
    '10': { name: '정령 스킬A', type: 'MemospriteSkill' },
    '11': { name: '정령 스킬B', type: 'MemospriteSkill' },
  };
  const ranks: Ranks = {
    r1: ups(), r2: ups(),
    r3: ups(['1', 1], ['2', 1], ['3', 1], ['10', 1], ['11', 1]),
    r4: ups(), r5: ups(), r6: ups(),
  };
  const srr = srrWith({ ranks, skills });
  const per = srrLevelBonuses(srr, { ranks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] });
  assert.deepEqual(per, [{}, {}, { basic: 1, memosprite_skill: 1 }, {}, {}, {}]);
});

test('srrLevelBonuses: 같은 순번에서 특성과 이름이 같은 능동 스킬 id는 연계 스킬이라 제외 (카스토리스 E3)', () => {
  const skills: Skills = {
    '140701': { name: '애도, 사해의 파문', type: 'Normal' },
    '140702': { name: '침묵, 나비의 손길', type: 'BPSkill' },
    '140703': { name: '포효하는 망자', type: 'Ultra' },
    '140704': { name: '손바닥에 흐르는 황무', type: 'Talent' },
    '140709': { name: '뼈의 발톱', type: 'BPSkill' },
    '1140701': { name: '어둠을 찢는 발톱', type: 'MemospriteSkill' },
    '1140702': { name: '암흑을 불태우는 화염의 숨결', type: 'MemospriteSkill' },
    '1140703': { name: '달의 고치에 가려진 몸체', type: 'MemospriteTalent' },
    '1140705': { name: '적막한 땅을 뒤흔드는 포효', type: 'MemospriteTalent' },
    '1140706': { name: '묘지를 불사르는 어둠의 날개', type: 'MemospriteTalent' },
    '1140712': { name: '묘지를 불사르는 어둠의 날개', type: 'MemospriteSkill' },
  };
  const ranks: Ranks = {
    r1: ups(), r2: ups(),
    r3: ups(['140703', 2], ['140701', 1], ['1140703', 1], ['1140712', 1], ['1140705', 1], ['1140706', 1]),
    r4: ups(),
    r5: ups(['140702', 2], ['140704', 2], ['1140701', 1], ['140709', 2], ['1140702', 1]),
    r6: ups(),
  };
  const per = srrLevelBonuses(srrWith({ ranks, skills }), { ranks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] });
  assert.deepEqual(per, [{}, {}, { ultimate: 2, basic: 1, memosprite_talent: 1 }, {}, { skill: 2, talent: 2, memosprite_skill: 1 }, {}]);
});

test('srrLevelBonuses: 필요한 데이터가 없으면 null (성혼 id 누락, 파일 없음)', () => {
  const skills: Skills = { '1': { name: 'x', type: 'Normal' } };
  assert.equal(srrLevelBonuses(srrWith({ ranks: null, skills }), { ranks: ['a', 'b', 'c', 'd', 'e', 'f'] }), null);
  assert.equal(srrLevelBonuses(srrWith({ ranks: {}, skills: null }), { ranks: ['a', 'b', 'c', 'd', 'e', 'f'] }), null);
  assert.equal(srrLevelBonuses(srrWith({ ranks: { a: ups() }, skills }), { ranks: ['a', 'b', 'c', 'd', 'e', 'f'] }), null, '성혼 id가 일부 없음');
  assert.equal(srrLevelBonuses(srrWith({ ranks: { a: ups() }, skills }), { ranks: ['a'] }), null, '성혼이 6개 미만');
});

test('성혼 레벨 보정: 위키가 "기억 정령 특성"을 E3·E5에 중복 기재한 오기를 바로잡는다 (에버나이트)', () => {
  const skills: Skills = {
    '141301': { name: '평타', type: 'Normal' },
    '141302': { name: '전투 스킬', type: 'BPSkill' },
    '141303': { name: '필살기', type: 'Ultra' },
    '141304': { name: '특성', type: 'Talent' },
    '1141301': { name: '정령 스킬 1', type: 'MemospriteSkill' },
    '1141307': { name: '정령 스킬 2', type: 'MemospriteSkill' },
    '1141303': { name: '정령 특성 1', type: 'MemospriteTalent' },
    '1141305': { name: '정령 특성 2', type: 'MemospriteTalent' },
  };
  const ranks: Ranks = {
    a1: ups(), a2: ups(),
    a3: ups(['141302', 2], ['141301', 1], ['1141303', 1], ['1141305', 1]),
    a4: ups(),
    a5: ups(['141303', 2], ['141304', 2], ['1141301', 1], ['1141307', 1]),
    a6: ups(),
  };
  const hit = { id: '1413', name: '에버나이트', path: 'Memory', element: 'Ice', ranks: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] };
  const pts = {
    ...standardPoints(),
    P01: skillPoint('평타', '일반 공격', '[단일 공격] | 강인성 감소 수치: 10', 10),
    P02: skillPoint('스킬', '전투 스킬', '[강화]', 15),
    P03: skillPoint('필살', '필살기', '[강화] | 에너지 소모 150', 15),
    P04: skillPoint('특성', '특성', '[강화]', 15),
    F1: skillPoint('정령 특성', '기억 정령 특성', '[강화]', 10),
    F2: skillPoint('정령 스킬', '기억 정령 스킬', '[단일 공격]', 10),
  };
  const eidolons = Array.from({ length: 6 }, (_, i) => ({
    name: `E${i + 1}`,
    desc: `<p>${
      i === 2
        ? '전투 스킬 레벨+2, 최대 Lv.15. 일반 공격 레벨+1, 최대 Lv.10. 기억 정령 특성 레벨+1, 최대 Lv.10'
        : i === 4
          ? '필살기 레벨+2, 최대 Lv.15. 특성 레벨+2, 최대 Lv.15. 기억 정령 특성 레벨+1, 최대 Lv.10'
          : '효과'
    }</p>`,
  }));
  const c = normalizeCharacter(makePage({ name: '에버나이트', path: '기억', element: '얼음', points: pts, eidolons }), undefined, { eidolon: 6 });
  assert.equal(c.skills.find((s) => s.kind === 'memosprite_skill')?.level_used, 6, '보정 전: 위키 오기로 정령 스킬이 오르지 않는다');
  enrichCharacter(c, srrWith({ chars: { '1413': hit }, ranks, skills }));
  assert.equal(c.skills.find((s) => s.kind === 'memosprite_skill')?.level_used, 7);
  assert.equal(c.skills.find((s) => s.kind === 'memosprite_talent')?.level_used, 7);
  assert.ok(c.warnings.some((w) => w.includes('E5')));
});

test('reconcileLevelBonuses: 단독 호출도 안전 (데이터 없음 → 변화 없음)', () => {
  const c = xgPage(6, XG_TYPO);
  reconcileLevelBonuses(c, srrWith({ ranks: null, skills: null }), XG_HIT);
  assert.equal(c.eidolon_level_bonus_source, 'wiki');
  assert.equal(levelOf(c, 'elation_skill'), 11);
});
