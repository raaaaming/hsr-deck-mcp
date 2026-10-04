import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSkillLevels, normalizeCharacter, parseLevelBonus, SKILL_KIND_KO, SkillOut } from '../src/lib/character';
import { lcBaseFromEntry } from '../src/lib/lightcone';
import { findSrrCharacter, fuzzyBest, nameSimilarity, SrrData } from '../src/lib/enrich';
import { normName } from '../src/lib/util';
import { minorForm, makePage, minorPoint, point, skillPoint, standardPoints } from './helpers';

const kinds = (c: ReturnType<typeof normalizeCharacter>) => c.skills.map((s) => s.kind).sort();

test('표준 구성: 스킬 5종, 작은 행적 10개, 큰 행적 3개, 합계', () => {
  const c = normalizeCharacter(makePage({ name: '시험' }), undefined, { eidolon: 0 });
  assert.deepEqual(kinds(c), ['basic', 'skill', 'talent', 'technique', 'ultimate']);
  assert.equal(c.minor_traces.count, 10);
  assert.equal(c.minor_traces.unparsed.length, 0);
  assert.equal(c.major_traces.length, 3);
  assert.deepEqual(c.warnings, []);
  const t = c.minor_traces.totals;
  assert.equal(t.atk.pct, 18);
  assert.equal(t.crit_rate.pct, 6.7);
  assert.equal(t.spd.flat, 5);
  assert.equal(t.elemental_dmg.pct, 8);
  assert.equal(t.elemental_dmg.element, 'Quantum');
  assert.equal(t.def.pct, 5);
  assert.equal(c.base_stats_lv80.hp, 1397);
  assert.equal(c.base_stats_lv80.spd, 101);
  assert.equal(c.rarity, 5);
  assert.equal(c.path, 'Warlock');
  assert.equal(c.element, 'Quantum');
  const ult = c.skills.find((s) => s.kind === 'ultimate')!;
  assert.equal(ult.energy, 120);
  assert.equal(ult.toughness, 20);
});

test('스킬 레벨: 기본 6/10에서 시작 (성혼 없음)', () => {
  const c = normalizeCharacter(makePage({ name: '시험' }), undefined, { eidolon: 0 });
  const lv = Object.fromEntries(c.skills.map((s) => [s.kind, s.level_used]));
  assert.equal(lv.basic, 6);
  assert.equal(lv.skill, 10);
  assert.equal(lv.ultimate, 10);
  assert.equal(lv.talent, 10);
});

test('작은 행적: 본문에 능력치 이름이 없으면 제목에서 읽는다 (은랑 LV.999 P12)', () => {
  const pts = standardPoints();
  pts.P12 = minorPoint('환락도 강화', '4.0% 증가');
  const c = normalizeCharacter(makePage({ name: '시험', points: pts }));
  assert.equal(c.minor_traces.count, 10);
  assert.equal(c.minor_traces.totals.elation.pct, 4);
});

test('작은 행적: 위키에 값이 비어 있으면 unparsed로 남기고 경고', () => {
  const pts = standardPoints();
  pts.P09 = minorPoint('피해 강화•양자', '양자 속성 피해 증가'); // 청작 E2
  pts.P10 = minorPoint('공격 강화', '공격력'); // 삼포 D1
  const c = normalizeCharacter(makePage({ name: '시험', points: pts }));
  assert.equal(c.minor_traces.count, 8);
  assert.equal(c.minor_traces.unparsed.length, 2);
  assert.ok(c.warnings.some((w) => w.includes('읽지 못했습니다')));
  assert.equal(c.major_traces.length, 3); // 값 없는 행적이 큰 행적으로 오분류되면 안 된다
});

test('꺾쇠 없는 평문 머리글(사이퍼)과 머리글 없는 행적', () => {
  const pts: ReturnType<typeof standardPoints> = {
    A: skillPoint('필살', '필살기', '[확산] | 강인성 감소 수치: 30', 6, { plain: true }),
    B: skillPoint('특성', '특성', '[단일 공격] | 강인성 감소 수치: 20', 10, { plain: true }),
    C: skillPoint('스킬', '전투 스킬', '[확산] | 강인성 감소 수치: 20', 10, { plain: true }),
    D: point({ title: '장화 신은 고양이', header: undefined, plain: '비술', lines: ['[강화]', '[자그레우스의 축복]을 획득한다, 지속 시간: 15초'] }),
    E: skillPoint('평타', '일반 공격', '[단일 공격] | 강인성 감소 수치: 10', 6, { plain: true }),
    B1: point({ title: '해를 바꿔치기한 대도', header: null, lines: ['특성의 추가 공격이 가하는 치명타 피해가 100% 증가한다. 필살기 발동 시 속도가 20% 증가한다'], form: minorForm() }),
    C1: point({ title: '300 의적', header: null, lines: ['아군이 [단골손님]을 제외한 적에게 가하는 피해가 증가한다. 최대 30%'], form: minorForm() }),
    E1: point({ title: '신행의 신발', header: null, lines: ['속도가 140/170 이상일 시 치명타 확률이 25%/50% 증가한다'], form: minorForm() }),
  };
  const minors = ['양자 속성 피해 6.4% 증가', '효과 명중 6% 증가', '속도 3 증가', '속도 3 증가', '양자 속성 피해 4.8% 증가', '속도 2 증가', '속도 4 증가', '양자 속성 피해 3.2% 증가', '속도 2 증가', '효과 명중 4% 증가'];
  const titles = ['피해 강화•양자', '효과 명중 강화', '속도 강화', '속도 강화', '피해 강화•양자', '속도 강화', '속도 강화', '피해 강화•양자', '속도 강화', '효과 명중 강화'];
  minors.forEach((m, i) => (pts[`M${i}`] = point({ title: titles[i], header: null, lines: [m], form: minorForm() })));
  const c = normalizeCharacter(makePage({ name: '사이퍼형', points: pts }));
  assert.deepEqual(kinds(c), ['basic', 'skill', 'talent', 'technique', 'ultimate']);
  assert.equal(c.major_traces.length, 3);
  assert.equal(c.minor_traces.count, 10);
  assert.equal(c.minor_traces.unparsed.length, 0);
  const ult = c.skills.find((s) => s.kind === 'ultimate')!;
  assert.equal(ult.max_level, 6);
  assert.equal(ult.toughness, 30);
});

test('머리글 없는 작은 행적: 표 머리에 빈 칸이 붙어도 스킬로 오인하지 않는다 (미샤)', () => {
  const pts = standardPoints();
  pts.P09 = point({ title: '피해 강화•얼음', header: null, lines: ['얼음 속성 피해 6.4% 증가'], form: minorForm(true) });
  pts.P06 = point({ title: '트랜스미션', header: null, lines: ['빙결 상태에 빠진 적에게 피해를 가할 시 치명타 피해가 30% 증가한다'], form: minorForm(true) });
  const c = normalizeCharacter(makePage({ name: '미샤형', points: pts }));
  assert.ok(!kinds(c).includes('other'));
  assert.equal(c.minor_traces.count, 10);
  assert.equal(c.major_traces.length, 3);
});

test('F1/F2 키의 머리글 없는 스킬은 기억 정령 특성/스킬 (카스토리스)', () => {
  const pts = standardPoints();
  pts.F1 = point({ title: '달의 고치', header: null, lines: ['[서포트]', '죽음의 용이 필드에 있을 시 아군을 후방 지원한다'], form: skillPointForm(7) });
  pts.F2 = point({ title: '어둠을 찢는 발톱', header: null, lines: ['[범위 공격]', '모든 적에게 피해를 준다'], form: skillPointForm(7) });
  const c = normalizeCharacter(makePage({ name: '카스형', points: pts, path: '기억' }));
  assert.equal(c.skills.find((s) => s.key === 'F1')!.kind, 'memosprite_talent');
  assert.equal(c.skills.find((s) => s.key === 'F2')!.kind, 'memosprite_skill');
});

function skillPointForm(n: number) {
  return skillPoint('x', '특성', '[a]', n).form;
}

test('같은 머리글이 둘이면 레벨 표 없는 쪽이 비술 (아처)', () => {
  const pts = standardPoints();
  pts.P05 = point({ title: '천리안', header: '특성', lines: ['강인성 감소 수치: 20', '즉시 적을 공격하며, 전투 진입 후 모든 적에게 피해를 준다'] });
  const c = normalizeCharacter(makePage({ name: '아처형', points: pts }));
  assert.deepEqual(kinds(c), ['basic', 'skill', 'talent', 'technique', 'ultimate']);
  assert.ok(c.warnings.some((w) => w.includes('비술로 분류')));
});

test('머리글 없는 비술 (블랙 스완, 마이데이)', () => {
  const pts = standardPoints();
  pts.P05 = point({ title: '진상을 파악하고', header: null, lines: ['비술 사용 후, 다음 전투 시작 시 150%의 기본 확률로 적을 상태에 빠트린다'], form: minorForm() });
  const c = normalizeCharacter(makePage({ name: '스완형', points: pts }));
  assert.ok(kinds(c).includes('technique'));
  assert.equal(c.major_traces.length, 3);
});

test('속성 보너스 머리글을 단 추가 능력은 큰 행적 (영사 D3, 아를란 D2/B1)', () => {
  const pts = standardPoints();
  pts.P10 = minorPoint('적향', '자신의 공격력/치유량이 격파 특수효과의 25%/10%만큼 증가하며, 공격력/치유량은 최대 50%/20% 증가한다');
  pts.P11 = minorPoint('인내', '지속 피해류 디버프 상태에 대한 효과 저항이 50% 증가한다');
  pts.P12 = minorPoint('방어 저항', '전투 진입 시 현재 HP 백분율이 50% 이하일 경우, 모든 저항이 증가한다');
  const c = normalizeCharacter(makePage({ name: '영사형', points: pts }));
  assert.equal(c.major_traces.length, 6);
  assert.equal(c.minor_traces.count, 7);
});

test('레벨 표 머리 칸이 "Level"이어도 인식 (개척자 기억)', () => {
  const pts = standardPoints();
  pts.P01 = point({ title: '평타', header: '일반 공격', lines: ['[단일 공격] | 강인성 감소 수치: 10', '피해'], form: skillPointFormHead('Level', 6) });
  const c = normalizeCharacter(makePage({ name: '개척자 • 기억형', points: pts }));
  assert.equal(c.skills.find((s) => s.kind === 'basic')!.max_level, 6);
});

function skillPointFormHead(head: string, n: number) {
  const th = Array.from({ length: n }, (_, i) => `<td><p>레벨 ${i + 1}</p></td>`).join('');
  return `<table><tbody><tr><td><p>${head}</p></td>${th}</tr><tr><td><p>피해</p></td>${Array.from({ length: n }, (_, i) => `<td><p>${50 + i * 10}%</p></td>`).join('')}</tr></tbody></table>`;
}

test('기초 능력치: 오기된 "Lv.. 80" 키도 읽는다 (스파클)', () => {
  const c = normalizeCharacter(makePage({ name: '스파클형', asc80: { key: 'Lv.. 80', hp: '1397', atk: '523', def: '485', spd: '101' } }));
  assert.equal(c.base_stats_lv80.hp, 1397);
  assert.equal(c.base_stats_lv80.atk, 523);
  assert.equal(c.base_stats_lv80.def, 485);
});

test('비술에 다른 스킬의 레벨 표가 잘못 붙어 있어도 비술이며 레벨이 없다 (개척자 기억 B)', () => {
  const pts = standardPoints();
  pts.P05 = point({ title: '되살아난 기억', header: null, lines: ['비술 사용 후 10초 동안 지속되는 특수 영역을 만든다'], form: skillPointFormHead('행적 레벨', 12) });
  const c = normalizeCharacter(makePage({ name: '개척자 • 기억형', points: pts }));
  const t = c.skills.find((s) => s.kind === 'technique')!;
  assert.ok(t, '비술이 있어야 한다');
  assert.equal(t.max_level, 0);
  assert.equal(t.rows?.length, 0);
  assert.equal(c.skills.filter((s) => s.kind === 'other').length, 0);
  assert.equal(c.skill_levels[t.key], undefined);
});

test('큰 행적 4개: 개척 임무로 여는 4번째는 정상(경고 없음), 임무 언급이 없으면 경고', () => {
  const pts = standardPoints();
  pts.P20 = point({ title: '미완의 에필로그', header: '추가 능력', lines: ['필살기 발동 후 [서사시]를 얻는다', '개척 임무 「떨어진 꽃잎이여」 완료'] });
  const ok = normalizeCharacter(makePage({ name: '개척자 • 기억형', points: pts }));
  assert.equal(ok.major_traces.length, 4);
  assert.ok(!ok.warnings.some((w) => w.includes('큰 행적')), ok.warnings.join('|'));
  const pts2 = standardPoints();
  pts2.P20 = point({ title: '다른 효과', header: '추가 능력', lines: ['필살기 발동 후 공격력이 증가한다'] });
  const bad = normalizeCharacter(makePage({ name: '이상한형', points: pts2 }));
  assert.ok(bad.warnings.some((w) => w.includes('큰 행적')));
});

test('행적 칸은 있으나 비어 있고 능력치도 없으면 incomplete (에이언즈★아하 실제 응답)', () => {
  const c = normalizeCharacter(makePage({ name: '에이언즈★아하', points: {}, asc80: null, eidolons: [] }));
  assert.equal(c.incomplete, true);
});

test('SRR 매칭: "이름•운명의 길" 접미사를 떼고 길·속성이 같은 쪽을 고른다 (Mar. 7th•수렵)', () => {
  const mk = (id: string, name: string, path: string, element: string) => ({ id, name, path, element });
  const chars: Record<string, any> = {
    '1001': mk('1001', 'Mar. 7th', 'Knight', 'Ice'),
    '1224': mk('1224', 'Mar. 7th', 'Rogue', 'Imaginary'),
    '8001': mk('8001', '{NICKNAME}', 'Warrior', 'Physical'),
    '8002': mk('8002', '{NICKNAME}', 'Warrior', 'Physical'),
    '8007': mk('8007', '{NICKNAME}', 'Memory', 'Ice'),
  };
  const byCharName = new Map<string, any[]>();
  for (const v of Object.values(chars)) {
    const k = normName(v.name);
    byCharName.set(k, [...(byCharName.get(k) ?? []), v]);
  }
  const srr = { chars, promos: {}, lcs: {}, lcPromos: {}, trees: null, byCharName, byLcName: new Map() } as unknown as SrrData;
  assert.equal(findSrrCharacter({ name: 'Mar. 7th•수렵', path: 'Rogue', element: 'Imaginary' }, srr)?.id, '1224');
  assert.equal(findSrrCharacter({ name: 'Mar. 7th', path: 'Knight', element: 'Ice' }, srr)?.id, '1001');
  assert.equal(findSrrCharacter({ name: '개척자 • 기억', path: 'Memory', element: 'Ice' }, srr)?.id, '8007');
  // 길이 다르면 이름 접두사만으로 엉뚱한 캐릭터를 고르지 않는다
  assert.equal(findSrrCharacter({ name: 'Mar. 7th•보존', path: 'Preservation', element: 'Ice' }, srr), null);
});

test('상세 데이터가 없는 항목은 incomplete (에이언즈★아하)', () => {
  const c = normalizeCharacter(makePage({ name: '에이언즈★아하', noTrace: true, asc80: null, eidolons: [] }));
  assert.equal(c.incomplete, true);
});

test('성혼 레벨 보너스 파싱: 정상/오기/중복', () => {
  assert.deepEqual(parseLevelBonus('필살기 레벨+2, 최대 Lv.15. 특성 레벨+2, 최대 Lv.15'), { ultimate: 2, talent: 2 });
  assert.deepEqual(parseLevelBonus('전투 스킬 레벨+2, 최대 Lv.15, 일반 공격 레벨+1, 최대 Lv.10'), { skill: 2, basic: 1 });
  // 위키 오기: "저투 스킬"
  assert.deepEqual(parseLevelBonus('저투 스킬 레벨+2, 최대 Lv.15. 특성 레벨+2, 최대 Lv.15. 환락 스킬 레벨+1, 최대 Lv.15'), { skill: 2, talent: 2, elation_skill: 1 });
  assert.deepEqual(parseLevelBonus('필살기 레벨+2, 최대 Lv.15. 특성 레벨+2, 최대 Lv.15. 기억 정령 스킬 레벨+1, 최대 Lv.10'), { ultimate: 2, talent: 2, memosprite_skill: 1 });
  assert.deepEqual(parseLevelBonus('필살기 레벨+2, 최대 Lv.15. 일반 공격 레벨+1, 최대 Lv.10. 환락 스킬 레벨+1, 최대 Lv.15'), { ultimate: 2, basic: 1, elation_skill: 1 });
  // 같은 종류 중복(키레네 E5의 중복 기재)은 합산하지 않고 최댓값
  const dup = parseLevelBonus('전투 스킬 레벨+2, 최대 Lv.15. 일반 공격 레벨+1, 최대 Lv.10. 전투 스킬 레벨+2, 최대 Lv.15. 일반 공격 레벨+1, 최대 Lv.10');
  assert.deepEqual(dup, { skill: 2, basic: 1 });
  assert.deepEqual(parseLevelBonus('피해가 증가한다'), {});
});

const mk = (key: string, kind: SkillOut['kind'], max: number): SkillOut => ({ key, kind, kind_ko: SKILL_KIND_KO[kind], title: key, text: '', max_level: max });
const eid = (rank: number, bonus: Record<string, number>) => ({ rank, name: '', text: '', level_bonus: bonus as any, hints: [] });

test('스킬 레벨 계산: 표가 15레벨까지 수록된 구형 캐릭터 (브로냐)', () => {
  const skills = [mk('A', 'ultimate', 15), mk('B', 'talent', 15), mk('C', 'skill', 15), mk('E', 'basic', 7)];
  const e = [eid(3, { ultimate: 2, talent: 2 }), eid(5, { skill: 2, basic: 1 })];
  assert.deepEqual(computeSkillLevels(skills, e, 0), { A: 10, B: 10, C: 10, E: 6 });
  assert.deepEqual(computeSkillLevels(skills, e, 3), { A: 12, B: 12, C: 10, E: 6 });
  assert.deepEqual(computeSkillLevels(skills, e, 6), { A: 12, B: 12, C: 12, E: 7 });
});

test('스킬 레벨 계산: 표가 기본 레벨까지만 수록된 최신 캐릭터 (달리아) → 표 끝 값 + 안내', () => {
  const skills = [mk('A', 'ultimate', 10), mk('B', 'talent', 10), mk('C', 'skill', 10), mk('E', 'basic', 6)];
  const e = [eid(3, { ultimate: 2, basic: 1 }), eid(5, { skill: 2, talent: 2 })];
  const notes: string[] = [];
  assert.deepEqual(computeSkillLevels(skills, e, 6, notes), { A: 10, B: 10, C: 10, E: 6 });
  assert.equal(notes.length, 4);
  assert.deepEqual(computeSkillLevels(skills, e, 0), { A: 10, B: 10, C: 10, E: 6 });
});

test('스킬 레벨 계산: 환락 스킬·기억 정령은 상한 적용 (어벤츄린•웨이브, 키레네)', () => {
  const skills = [mk('P22', 'elation_skill', 12), mk('F1', 'memosprite_talent', 7), mk('F2', 'memosprite_skill', 7)];
  const e = [
    eid(3, { elation_skill: 1, memosprite_skill: 1 }),
    eid(5, { elation_skill: 1, memosprite_skill: 1, memosprite_talent: 1 }), // 중복 기재된 오기
  ];
  assert.deepEqual(computeSkillLevels(skills, e, 6), { P22: 12, F1: 7, F2: 7 });
  assert.deepEqual(computeSkillLevels(skills, e, 0), { P22: 10, F1: 6, F2: 6 });
});

test('광추 상세 페이지: 방어력 행 라벨이 "기초 공격력"으로 중복된 오기를 순서로 읽는다 (휴일의 목욕탕 대모험)', () => {
  const data = JSON.stringify({
    list: [
      {
        key: 'Lv.80',
        combatList: [
          { key: '', values: ['돌파 전', '돌파 후'] },
          { key: '기초 HP', values: ['1058', '-'] },
          { key: '기초 공격력', values: ['529', '-'] },
          { key: '기초 공격력', values: ['330', '-'] },
        ],
      },
    ],
  });
  const page = { id: '3895', name: 'x', modules: [{ name: 'a', components: [{ component_id: 'ascension', data }] }] };
  assert.deepEqual(lcBaseFromEntry(page as any), { hp: 1058, atk: 529, def: 330 });
});

test('이름 유사도: 번역 표기 차이("따뜻한"/"따듯한")는 같은 항목으로, 다른 항목은 아니다', () => {
  assert.ok(nameSimilarity('따뜻한 밤은 길지 않고', '따듯한 밤은 길지 않고') >= 0.7);
  assert.ok(nameSimilarity('같은 심정', '등가교환') < 0.3);
  assert.equal(nameSimilarity('abc', 'ABC'), 1);
  const group = ['수술 후의 대화', '같은 심정', '알맞은 타이밍', '등가교환', '따듯한 밤은 길지 않고', '무엇이 진실인가', '꿈의 몽타주', '내일의 내일이 올 때까지', '저기, 나 여기 있어'].map((name) => ({ name }));
  assert.equal(fuzzyBest('따뜻한 밤은 길지 않고', group)?.name, '따듯한 밤은 길지 않고');
  assert.equal(fuzzyBest('전혀 다른 이름', group), null);
  // 비슷한 후보가 둘이면 포기한다
  assert.equal(fuzzyBest('밤은 길지 않고', [{ name: '밤은 길지 않고 A' }, { name: '밤은 길지 않고 B' }]), null);
});
