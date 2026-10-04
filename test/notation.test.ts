import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemberToken, parseOptions, resolveParty, splitPartyText } from '../src/lib/notation';
import roster from '../src/data/roster.json';

// 실제 위키 ID/이름(roster.json 기준선) + 시험에 필요한 항목만 운명의 길 정보를 붙인 미니 로스터
const R = roster as unknown as { characters: Record<string, string>; light_cones: Record<string, string> };
const withFilters = (id: string, name: string, f: Record<string, string>) => ({
  entry_page_id: id,
  name,
  filter_values: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { values: [v] }])),
});
const CHAR_INFO: Record<string, Record<string, string>> = {
  '4997': { character_paths: '환락', character_rarity: '★5', character_combat_type: '허수' },
  '5005': { character_paths: '환락', character_rarity: '★5', character_combat_type: '물리' },
  '10192': { character_paths: '환락', character_rarity: '★5', character_combat_type: '얼음' },
  '1807': { character_paths: '화합', character_rarity: '★5', character_combat_type: '양자' },
  '3560': { character_paths: '기억', character_rarity: '★5', character_combat_type: '양자' },
  '7': { character_paths: '보존', character_rarity: '★4', character_combat_type: '얼음' },
  '2657': { character_paths: '수렵', character_rarity: '★4', character_combat_type: '허수' },
};
const LC_INFO: Record<string, Record<string, string>> = {
  '5218': { equipment_paths: '환락' },
  '5219': { equipment_paths: '환락' },
  '10394': { equipment_paths: '환락' },
  '4777': { equipment_paths: '환락' }, // 슈룸 모험기
  '1936': { equipment_paths: '화합' },
  '3698': { equipment_paths: '기억' },
};
const characters = Object.entries(R.characters).map(([id, name]) => withFilters(id, name, CHAR_INFO[id] ?? {}));
const lightCones = Object.entries(R.light_cones).map(([id, name]) => withFilters(id, name, LC_INFO[id] ?? {}));
const resolve = (t: string) => resolveParty(t, { characters: characters as any, lightCones: lightCones as any });

test('표기 해석: 예시 파티 — 은랑Lv.999(풀돌풀재), 에바네시아(1돌전광), 펄(1돌,슈룸모험기)', () => {
  const { members, warnings } = resolve('은랑Lv.999(풀돌풀재), 에바네시아(1돌전광), 펄(1돌,슈룸모험기)');
  assert.equal(members.length, 3);
  const [a, e, p] = members;

  assert.equal(a.character?.name, '은랑 LV.999');
  assert.equal(a.eidolon, 6);
  assert.equal(a.eidolon_source, 'specified');
  assert.equal(a.light_cone.mode, 'signature');
  assert.equal(a.light_cone.id, '5218');
  assert.equal(a.light_cone.superimposition, 5);
  assert.equal(a.light_cone.superimposition_source, 'specified');
  assert.ok(a.notes.some((n) => n.includes('Lv.999') && n.includes('레벨이 아닙니다')));

  assert.equal(e.character?.name, '에바네시아');
  assert.equal(e.eidolon, 1);
  assert.equal(e.light_cone.mode, 'signature');
  assert.equal(e.light_cone.id, '5219');
  assert.equal(e.light_cone.superimposition, 1);
  assert.equal(e.light_cone.superimposition_source, 'default');

  assert.equal(p.character?.name, '펄');
  assert.equal(p.eidolon, 1);
  assert.equal(p.light_cone.mode, 'named', '전용 광추가 아니라 지정한 광추');
  assert.equal(p.light_cone.name, '슈룸 모험기');
  assert.ok(p.notes.some((n) => n.includes('전용 광추가 아닌')));
  assert.equal(p.light_cone.path_match, true);
  assert.deepEqual(warnings, []);
});

test('표기 해석: 구분자는 괄호 바깥만, 여러 형식(+ / ; 줄바꿈)', () => {
  assert.deepEqual(splitPartyText('펄(1돌,슈룸모험기), 스파클(전광) + 카스토리스 / 은랑\n효광; 아글라이아'), ['펄(1돌,슈룸모험기)', '스파클(전광)', '카스토리스', '은랑', '효광', '아글라이아']);
});

test('표기 해석: 성혼/재련 표기 변형', () => {
  const o = (s: string) => parseOptions(s);
  assert.equal(o('풀돌').eidolon, 6);
  assert.equal(o('만돌').eidolon, 6);
  assert.equal(o('무돌').eidolon, 0);
  assert.equal(o('1돌').eidolon, 1);
  assert.equal(o('E2').eidolon, 2);
  assert.equal(o('e3').eidolon, 3);
  assert.equal(o('성혼4').eidolon, 4);
  assert.equal(o('5성혼').eidolon, 5);
  assert.equal(o('풀재').superimposition, 5);
  assert.equal(o('3재').superimposition, 3);
  assert.equal(o('S5').superimposition, 5);
  assert.equal(o('중첩2').superimposition, 2);
  assert.equal(o('전광').signature, true);
  assert.equal(o('전용').signature, true);
  assert.equal(o('무광').no_lc, true);
  const mixed = o('2돌 전광 3재');
  assert.deepEqual([mixed.eidolon, mixed.superimposition, mixed.signature, mixed.lc_text], [2, 3, true, '']);
  assert.equal(o('1돌, 슈룸모험기').lc_text, '슈룸모험기');
});

test('표기 해석: 괄호 없이 공백으로 이어 쓴 표기 (카스토리스 2돌 전광 3재)', () => {
  const chars = characters.map((c) => ({ id: c.entry_page_id, name: c.name }));
  const pm = parseMemberToken('카스토리스 2돌 전광 3재', chars);
  assert.equal(pm.name_text, '카스토리스');
  assert.equal(pm.options.eidolon, 2);
  assert.equal(pm.options.superimposition, 3);
  assert.equal(pm.options.signature, true);
  const { members } = resolve('카스토리스 2돌 전광 3재');
  assert.equal(members[0].character?.name, '카스토리스');
  assert.equal(members[0].light_cone.id, '3698');
});

test('표기 해석: 기본값 가정(E0, S1)이 표시되고, 정확히 일치하는 이름이 우선한다', () => {
  const { members } = resolve('Mar. 7th, Mar. 7th•수렵(풀돌)');
  assert.equal(members[0].character?.id, '7');
  assert.equal(members[0].eidolon_source, 'default');
  assert.ok(members[0].notes.some((n) => n.includes('0돌(E0)로 가정')));
  assert.equal(members[1].character?.id, '2657');
  assert.equal(members[1].eidolon, 6);
});

test('표기 해석: 없는 캐릭터·광추는 경고로 알린다', () => {
  const r = resolve('없는캐릭터이름(풀돌), 펄(광추없는이름XYZ)');
  assert.equal(r.members[0].character, null);
  assert.ok(r.warnings.some((w) => w.includes('캐릭터를 찾지 못함')));
  assert.equal(r.members[1].light_cone.mode, 'unresolved');
  assert.ok(r.warnings.some((w) => w.includes('광추를 찾지 못함')));
});

test('표기 해석: 개척자(운명의 길) → "개척자 • 길"', () => {
  const { members } = resolve('개척자(환락)(풀돌전광)');
  assert.equal(members[0].character?.name, '개척자 • 환락');
  assert.equal(members[0].eidolon, 6);
  assert.equal(members[0].light_cone.mode, 'signature');
});

test('표기 해석: 광추 운명의 길이 다르면 경고한다', () => {
  const { members, warnings } = resolve('펄(슈룸모험기), 스파클(내일에바치는색채)');
  assert.equal(members[0].light_cone.path_match, true);
  assert.equal(members[1].light_cone.path_match, false);
  assert.ok(warnings.some((w) => w.includes('운명의 길 불일치')));
});
