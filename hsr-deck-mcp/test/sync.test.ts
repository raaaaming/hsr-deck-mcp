import test from 'node:test';
import assert from 'node:assert/strict';
import { WikiClient, EntryPage, Fetcher, ListItem } from '../src/lib/wiki';
import { SrrClient } from '../src/lib/enrich';
import { BASELINE, Roster, deriveSignatures, diffKind, ensureDerivedSignatures, fetchLists, resetDerivedState, runSync, signatureMentions } from '../src/lib/sync';
import { derivedSignatureList, signatureFor, signatureOwners } from '../src/lib/signature';
import { TOOLS, setServices } from '../src/lib/tools';
import { makePage } from './helpers';

// ───────── 가짜 위키/SRR 전송 계층 ─────────

interface Fx {
  lists: Record<'104' | '107' | '108', ListItem[]>;
  pages: Record<string, EntryPage>;
  hits: { list: number; entry: number };
}

const resp = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function fakeFetcher(fx: Fx): Fetcher {
  return async (url, init) => {
    if (url.includes('get_entry_page_list')) {
      fx.hits.list++;
      const body = JSON.parse(String(init?.body));
      const all = fx.lists[body.menu_id as '104'] ?? [];
      const start = (body.page_num - 1) * body.page_size;
      return resp({ retcode: 0, data: { list: all.slice(start, start + body.page_size), total: String(all.length) } });
    }
    if (url.includes('entry_page?')) {
      fx.hits.entry++;
      const id = new URL(url).searchParams.get('entry_page_id')!;
      const page = fx.pages[id];
      return page ? resp({ retcode: 0, data: { page } }) : resp({ retcode: 100010, message: 'not found' });
    }
    return resp({}, 404);
  };
}

const noSrr = async () => resp({}, 404);

const charItem = (id: string, name: string, path = '공허', rarity = '★5', element = '양자'): ListItem => ({
  entry_page_id: id,
  name,
  filter_values: { character_rarity: { values: [rarity] }, character_combat_type: { values: [element] }, character_paths: { values: [path] } },
});

const lcItem = (id: string, name: string, path = '공허', rarity = '★5', source = '한정 워프'): ListItem => ({
  entry_page_id: id,
  name,
  filter_values: { equipment_rarity: { values: [rarity] }, equipment_paths: { values: [path] }, equipment_source: { values: [source] } },
  display_field: {
    equipment_skill: '패시브<p>장착자의 공격력이 12%/14%/16%/18%/20% 증가한다</p>',
    attr_level_80: JSON.stringify({ base_hp: 1058, base_atk: 582, base_def: 463 }),
  },
});

const relicItem = (id: string, name: string, planar = false): ListItem => ({
  entry_page_id: id,
  name,
  filter_values: { relic_set: { values: [planar ? '2' : '4'] } },
  display_field: {
    two_set_effect: '<p>공격력이 12% 증가한다</p>',
    four_set_effect: planar ? '' : '<p>치명타 피해가 20% 증가한다</p>',
  },
});

/** 추천 세팅 모듈이 있는 캐릭터 페이지 (위키 실제 구조를 본뜸) */
function pageWithRecommendation(base: EntryPage, rows: { lcId: string; lcName: string; reason: string }[]): EntryPage {
  const html = rows
    .map((r) => `<tr><td><custom-entry amount="0" epid="${r.lcId}" icon="x" name="${r.lcName}" displaystyle="card" menuid="107"></custom-entry>${r.lcName} ★★★★★ 효과 설명 ${r.reason}</td></tr>`)
    .join('');
  return { ...base, modules: [...base.modules, { name: '추천 세팅', components: [{ component_id: 'customize', data: JSON.stringify({ data: `<table><tbody>${html}</tbody></table>` }) }] }] };
}

function newFx(): Fx {
  return { lists: { '104': [], '107': [], '108': [] }, pages: {}, hits: { list: 0, entry: 0 } };
}

// 기준선을 현재 위키 목록과 똑같이 만들어 주는 도우미
function baselineOf(fx: Fx, over: Partial<Roster> = {}): Roster {
  const m = (a: ListItem[]) => Object.fromEntries(a.map((i) => [String(i.entry_page_id), i.name.trim()]));
  return { generated: '2026-01-01T00:00:00Z', characters: m(fx.lists['104']), light_cones: m(fx.lists['107']), relics: m(fx.lists['108']), pending: [], ...over };
}

// ───────── 기준선 / 목록 비교 ─────────

test('기준선 파일: 배포 시점 목록이 들어 있다 (캐릭터 94, 광추 170, 유물 62)', () => {
  assert.equal(Object.keys(BASELINE.characters).length, 94);
  assert.equal(Object.keys(BASELINE.light_cones).length, 170);
  assert.equal(Object.keys(BASELINE.relics).length, 62);
  assert.ok(BASELINE.pending.includes('10393'));
  assert.equal(BASELINE.characters['10393'], '에이언즈★아하');
});

test('목록 비교: 신규/삭제/이름 변경 (공백·기호 차이는 같은 이름)', () => {
  const base = { '1': '가나다', '2': '라마바', '3': '아케론' };
  const items = [charItem('1', '가나다'), charItem('2', '라마 바 (개명)'), charItem('3', '아케론 '), charItem('9', '신규')];
  const d = diffKind(base, items);
  assert.deepEqual(d.added, [{ id: '9', name: '신규' }]);
  assert.deepEqual(d.renamed, [{ id: '2', from: '라마바', to: '라마 바 (개명)' }]);
  assert.deepEqual(d.removed, []);
  const d2 = diffKind(base, [charItem('1', '가나다')]);
  assert.deepEqual(d2.removed.map((r) => r.id).sort(), ['2', '3']);
});

// ───────── 위키 추천 세팅에서 전용 광추 읽기 ─────────

test('추천 세팅: "{캐릭터}의 전용 광추" 표기만 인정한다 (다른 캐릭터의 전용 광추를 추천한 줄은 제외)', () => {
  const base = makePage({ id: '2948', name: '영사' });
  const page = pageWithRecommendation(base, [
    { lcId: '3068', lcName: '오직 향만이 변함없이', reason: '영사의 전용 광추 격파 특수효과가 올라감' },
    { lcId: '806', lcName: '관의 울림', reason: '나찰의 전용 광추 치유 후 효과 저항 증가' },
    { lcId: '3327', lcName: '땀은 많이', reason: '괜찮은 선택지임' },
  ]);
  assert.deepEqual(signatureMentions(page, '영사'), [{ id: '3068', name: '오직 향만이 변함없이' }]);
  assert.deepEqual(signatureMentions(page, '나찰'), [{ id: '806', name: '관의 울림' }]);
  // 이름에 공백/점이 있어도 정규화해서 맞춘다
  const dh = pageWithRecommendation(makePage({ id: '3957', name: '단항 • 등황' }), [{ lcId: '4006', lcName: '끝없는 산과 강을', reason: '단항 • 등황의 전용 광추' }]);
  assert.equal(signatureMentions(dh, '단항 • 등황')[0]?.id, '4006');
  // 추천 세팅 모듈이 없으면 빈 배열
  assert.deepEqual(signatureMentions(base, '영사'), []);
});

// ───────── 전용 광추 자동 추정 ─────────

test('전용 광추 추정: 위키 명시(known) 우선, 그다음 같은 길의 1:1 ID 순서(probable), 개수가 다르면 보류', async () => {
  const fx = newFx();
  // 공허(Warlock): 새 캐릭터 1명 + 미배정 한정 광추 1개 → warp_order
  // 지식(Mage): 새 캐릭터 1명(추천 세팅에 명시) + 광추 2개 → wiki_recommendation (명시된 광추만)
  // 보존(Knight): 새 캐릭터 2명 + 광추 1개 → 보류
  fx.lists['104'] = [charItem('20001', '신규공허', '공허'), charItem('20002', '신규지식', '지식'), charItem('20003', '신규보존A', '보존'), charItem('20004', '신규보존B', '보존')];
  fx.lists['107'] = [lcItem('30001', '공허 새 광추', '공허'), lcItem('30002', '지식 새 광추 하나', '지식'), lcItem('30003', '지식 다른 새 광추', '지식'), lcItem('30004', '보존 새 광추', '보존'), lcItem('30005', '4성 광추', '공허', '★4')];
  fx.pages['20001'] = makePage({ id: '20001', name: '신규공허' });
  fx.pages['20002'] = pageWithRecommendation(makePage({ id: '20002', name: '신규지식' }), [{ lcId: '30003', lcName: '지식 다른 새 광추', reason: '신규지식의 전용 광추' }]);
  fx.pages['20003'] = makePage({ id: '20003', name: '신규보존A' });
  fx.pages['20004'] = makePage({ id: '20004', name: '신규보존B' });
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const lists = await fetchLists(wiki);
  const r = await deriveSignatures(wiki, lists);
  const by = (cid: string) => r.suggestions.filter((s) => s.character.id === cid);
  assert.equal(by('20001').length, 1);
  assert.equal(by('20001')[0].light_cone.id, '30001');
  assert.equal(by('20001')[0].confidence, 'probable');
  assert.equal(by('20001')[0].basis, 'warp_order');
  assert.equal(by('20002').length, 1);
  assert.equal(by('20002')[0].light_cone.id, '30003');
  assert.equal(by('20002')[0].confidence, 'known');
  assert.equal(by('20002')[0].basis, 'wiki_recommendation');
  // 지식 길의 30002는 주인이 없어 어느 쪽에도 배정되지 않는다
  assert.ok(!r.suggestions.some((s) => s.light_cone.id === '30002'));
  // 보존: 2명 ↔ 1개 → 보류
  assert.equal(by('20003').length + by('20004').length, 0);
  assert.deepEqual(r.unresolved.map((u) => u.character.id).sort(), ['20003', '20004']);
  assert.ok(r.unresolved[0].reason.includes('개수가 달라'));
});

test('전용 광추 추정: 이미 표에 있는 캐릭터/광추는 건드리지 않는다, 4성 캐릭터는 대상이 아니다', async () => {
  const fx = newFx();
  // 3560(카스토리스)는 표에 있고 3698은 이미 그의 전용 광추 → 새로 추정될 것이 없다
  fx.lists['104'] = [charItem('3560', '카스토리스', '기억'), charItem('20010', '새 4성', '공허', '★4')];
  fx.lists['107'] = [lcItem('3698', '이별이 더 아름답도록', '기억'), lcItem('30010', '새 공허 한정 광추', '공허')];
  fx.pages['3560'] = makePage({ id: '3560', name: '카스토리스' });
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const r = await deriveSignatures(wiki, await fetchLists(wiki));
  assert.equal(r.suggestions.length, 0);
  assert.equal(r.unresolved.length, 0);
});

test('전용 광추 추정: 위키 데이터 대기(pending_data) 캐릭터는 채워지면 추정 대상이 된다 (아하)', async () => {
  const fx = newFx();
  fx.lists['104'] = [charItem('10393', '에이언즈★아하', '환락')];
  fx.lists['107'] = [lcItem('40001', '환락 새 광추', '환락')];
  fx.pages['10393'] = makePage({ id: '10393', name: '에이언즈★아하' });
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const r = await deriveSignatures(wiki, await fetchLists(wiki));
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].character.id, '10393');
  assert.equal(r.suggestions[0].light_cone.id, '40001');
});

test('요청 경로의 추정 반영: ensureDerivedSignatures → signatureFor / signatureOwners', async () => {
  resetDerivedState();
  const fx = newFx();
  fx.lists['104'] = [charItem('20001', '신규공허', '공허')];
  fx.lists['107'] = [lcItem('30001', '공허 새 광추', '공허')];
  fx.pages['20001'] = makePage({ id: '20001', name: '신규공허' });
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  assert.equal(signatureFor('20001'), null);
  await ensureDerivedSignatures(wiki);
  const sig = signatureFor('20001');
  assert.equal(sig?.[0].id, '30001');
  assert.equal(sig?.[0].confidence, 'probable');
  assert.deepEqual(signatureOwners('30001'), [{ id: '20001', name: '신규공허' }]);
  assert.equal(derivedSignatureList().length, 1);
  // 표에 있는 캐릭터의 결과는 추정이 덮어쓰지 않는다
  assert.equal(signatureFor('3560')?.[0].id, '3698');
  resetDerivedState();
  assert.equal(signatureFor('20001'), null);
});

// ───────── 전체 점검 ─────────

test('runSync: 신규 캐릭터/광추/유물·이름 변경·삭제·위키 내용 채움을 한 번에 보고한다', async () => {
  resetDerivedState();
  const fx = newFx();
  fx.lists['104'] = [charItem('100', '기존 캐릭터'), charItem('101', '채워진 캐릭터'), charItem('102', '개명 전 이름'), charItem('300', '신규 5성'), charItem('301', '빈 신규')];
  fx.lists['107'] = [lcItem('200', '기존 광추'), lcItem('400', '신규 광추')];
  fx.lists['108'] = [relicItem('500', '기존 유물'), relicItem('600', '신규 동굴 유물'), relicItem('601', '신규 장신구', true)];
  fx.pages['101'] = makePage({ id: '101', name: '채워진 캐릭터' });
  fx.pages['300'] = makePage({ id: '300', name: '신규 5성' });
  fx.pages['301'] = makePage({ id: '301', name: '빈 신규', points: {}, asc80: null, eidolons: [] });
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const srr = new SrrClient(noSrr);
  const baseline: Roster = {
    generated: '2026-01-01T00:00:00Z',
    characters: { '100': '기존 캐릭터', '101': '채워진 캐릭터', '102': '이전 이름', '103': '삭제된 캐릭터' },
    light_cones: { '200': '기존 광추' },
    relics: { '500': '기존 유물' },
    pending: ['101'],
  };
  const r = await runSync({ wiki, srr }, { baseline, forceRefresh: true });
  assert.deepEqual(r.new_characters.map((c) => [c.id, c.status]).sort(), [['300', 'ready'], ['301', 'pending_data']]);
  assert.deepEqual(r.new_light_cones.map((l) => l.id), ['400']);
  assert.equal(r.new_light_cones[0].base_stats, true);
  assert.equal(r.new_light_cones[0].unassigned_signature_candidate, true);
  assert.deepEqual(r.new_relic_sets.map((x) => [x.id, x.type]).sort(), [['600', 'cavern'], ['601', 'planar']]);
  assert.deepEqual(r.became_ready.map((c) => c.id), ['101']);
  assert.deepEqual(r.still_pending.map((c) => c.id), ['301']);
  assert.deepEqual(r.renamed.map((x) => [x.kind, x.id]), [['character', '102']]);
  assert.deepEqual(r.removed.map((x) => [x.kind, x.id]), [['character', '103']]);
  assert.equal(r.starrailres_loaded, false);
  assert.ok(r.new_characters.find((c) => c.id === '300')!.issues.some((i) => i.includes('StarRailRes에 아직 없음')));
  assert.ok(r.needs_attention);
  assert.ok(r.summary[0].includes('캐릭터 2명, 광추 1개, 유물 세트 2개'));
  // 새 5성 캐릭터(공허) ↔ 새 5성 한정 광추(공허) 는 ID 순서로 짝지어져 추정 목록에 오른다 (신규 5성만 5성이고 '채워진 캐릭터' 등도 5성이지만 표에 없어 후보가 됨)
  assert.ok(Array.isArray(r.signature.suggestions));
});

test('runSync: 변화가 없으면 조용하다 (needs_attention=false)', async () => {
  resetDerivedState();
  const fx = newFx();
  fx.lists['104'] = [charItem('100', '기존', '공허', '★4')];
  fx.lists['107'] = [lcItem('200', '기존 광추', '공허', '★4')];
  fx.lists['108'] = [relicItem('500', '기존 유물')];
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const r = await runSync({ wiki, srr: new SrrClient(noSrr) }, { baseline: baselineOf(fx), forceRefresh: true });
  assert.equal(r.new_characters.length + r.new_light_cones.length + r.new_relic_sets.length, 0);
  assert.equal(r.needs_attention, false);
});

test('runSync(forceRefresh): 캐시를 무시하고 위키를 다시 읽는다', async () => {
  resetDerivedState();
  const fx = newFx();
  fx.lists['104'] = [charItem('100', '기존', '공허', '★4')];
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const baseline = baselineOf(fx);
  await runSync({ wiki, srr: new SrrClient(noSrr) }, { baseline, forceRefresh: true });
  // 위키에 새 캐릭터가 생겼다
  fx.lists['104'].push(charItem('101', '나중에 생김', '공허', '★4'));
  fx.pages['101'] = makePage({ id: '101', name: '나중에 생김', rarity: '★4' });
  const cached = await runSync({ wiki, srr: new SrrClient(noSrr) }, { baseline, forceRefresh: false });
  assert.equal(cached.new_characters.length, 0, '캐시가 살아 있으면 아직 안 보인다');
  const fresh = await runSync({ wiki, srr: new SrrClient(noSrr) }, { baseline, forceRefresh: true });
  assert.deepEqual(fresh.new_characters.map((c) => c.id), ['101']);
});

// ───────── MCP 툴: 목록에 없던 이름은 새로 읽어 다시 찾는다 ─────────

test('툴: 캐시된 목록에 없는 새 광추를 이름으로 조회하면 목록을 새로 읽어 찾는다', async () => {
  resetDerivedState();
  const fx = newFx();
  fx.lists['107'] = [lcItem('200', '기존 광추')];
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  setServices({ wiki, srr: new SrrClient(noSrr) });
  const tool = TOOLS.find((t) => t.name === 'hsr_get_light_cone')!;
  const first = await tool.run({ name_or_id: '기존 광추' }, { wiki, srr: new SrrClient(noSrr) });
  assert.equal(first.id, '200');
  // 위키에 새 광추가 추가됨 → 캐시(6h)에는 아직 없다
  fx.lists['107'].push(lcItem('201', '새로 나온 광추'));
  const second = await tool.run({ name_or_id: '새로 나온 광추' }, { wiki, srr: new SrrClient(noSrr) });
  assert.equal(second.id, '201');
  // 존재하지 않는 이름은 여전히 오류(그리고 방금 새로 읽었으므로 5분 안에는 또 읽지 않는다)
  const before = fx.hits.list;
  await assert.rejects(() => tool.run({ name_or_id: '없는 광추 ZZZ' }, { wiki, srr: new SrrClient(noSrr) }), /찾지 못했습니다/);
  assert.equal(fx.hits.list, before, '5분 한도 안이라 목록을 다시 읽지 않는다');
});

test('툴: hsr_check_updates 는 runSync 결과를 그대로 돌려준다', async () => {
  resetDerivedState();
  const fx = newFx();
  fx.lists['104'] = [charItem('100', '기존', '공허', '★4')];
  const wiki = new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 });
  const svc = { wiki, srr: new SrrClient(noSrr) };
  const tool = TOOLS.find((t) => t.name === 'hsr_check_updates')!;
  assert.ok(tool);
  const out = await tool.run({ refresh: true }, svc);
  // 기준선(실제 roster.json)과 가짜 위키가 전혀 다르므로 삭제/신규가 잔뜩 보인다 — 구조만 확인
  assert.equal(typeof out.generated_at, 'string');
  assert.ok(Array.isArray(out.summary));
  assert.equal(out.current_counts.characters, 1);
  assert.equal(out.baseline_counts.characters, 94);
});

// ───────── 알림 / 재배포 / 크론 라우트 ─────────

import { digest, maybeRedeploy, notifyWebhook } from '../src/lib/notify';
import type { SyncReport } from '../src/lib/sync';

function fakeReport(over: Partial<SyncReport> = {}): SyncReport {
  return {
    generated_at: '2026-10-03T03:17:00.000Z',
    baseline_generated: '2026-10-01T00:00:00Z',
    current_counts: { characters: 1, light_cones: 1, relic_sets: 1 },
    baseline_counts: { characters: 1, light_cones: 1, relic_sets: 1 },
    summary: ['기준선 대비 신규: 캐릭터 1명'],
    new_characters: [{ id: '1', name: '신규', rarity: 5, element: 'Quantum', path: 'Warlock', status: 'ready', issues: [], starrailres: false }],
    new_light_cones: [],
    new_relic_sets: [],
    became_ready: [],
    still_pending: [],
    renamed: [],
    removed: [],
    signature: { suggestions: [], unresolved: [] },
    skipped: [],
    starrailres_loaded: true,
    elapsed_ms: 10,
    needs_attention: true,
    ...over,
  };
}

test('알림: 웹훅 URL이 없거나 알릴 변화가 없으면 보내지 않는다, 있으면 content/text로 보낸다', async () => {
  const calls: { url: string; body: any }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response(null, { status: 204 });
  };
  assert.equal(await notifyWebhook(fakeReport(), {}, f), 'webhook 미설정');
  assert.equal(await notifyWebhook(fakeReport({ needs_attention: false }), { SYNC_WEBHOOK_URL: 'https://hook.example/x' }, f), '알릴 변화 없음');
  assert.equal(calls.length, 0);
  assert.equal(await notifyWebhook(fakeReport(), { SYNC_WEBHOOK_URL: 'https://hook.example/x' }, f), 'webhook 204');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hook.example/x');
  assert.equal(calls[0].body.content, calls[0].body.text);
  assert.ok(calls[0].body.text.includes('기준선 대비 신규'));
  // 전송 실패는 예외로 새지 않는다
  const bad = async () => {
    throw new Error('boom');
  };
  assert.match(await notifyWebhook(fakeReport(), { SYNC_WEBHOOK_URL: 'https://hook.example/x' }, bad), /webhook 실패: boom/);
  // 긴 요약은 잘라서 보낸다
  const long = fakeReport({ summary: Array.from({ length: 80 }, (_, i) => `줄 ${i} ${'가'.repeat(40)}`) });
  assert.ok(digest(long).length <= 1800);
});

test('재배포: 새 항목이 있고 기준선이 20시간 넘게 묵었을 때만 Deploy Hook을 부른다', async () => {
  let n = 0;
  const f = async () => {
    n++;
    return new Response('', { status: 201 });
  };
  const env = { SYNC_DEPLOY_HOOK_URL: 'https://api.vercel.com/v1/integrations/deploy/prj_x/y' };
  const t = Date.parse('2026-10-03T03:17:00Z');
  assert.equal(await maybeRedeploy(fakeReport(), {}, f, t), 'deploy hook 미설정');
  assert.equal(await maybeRedeploy(fakeReport({ new_characters: [] }), env, f, t), '재배포 불필요');
  assert.match(await maybeRedeploy(fakeReport({ baseline_generated: '2026-10-03T00:00:00Z' }), env, f, t), /재배포 건너뜀/);
  assert.equal(n, 0);
  assert.equal(await maybeRedeploy(fakeReport({ baseline_generated: '2026-10-01T00:00:00Z' }), env, f, t), '재배포 요청 201');
  assert.equal(n, 1);
  // 기준선 날짜가 깨져 있어도 재배포를 연타하지 않는다
  assert.match(await maybeRedeploy(fakeReport({ baseline_generated: 'garbage' }), env, f, t), /재배포 건너뜀/);
});

test('크론 라우트: CRON_SECRET이 없으면 503, 틀리면 401, 맞으면 점검 결과를 돌려준다', async () => {
  resetDerivedState();
  const { GET } = await import('../app/api/cron/sync/route');
  const fx = newFx();
  fx.lists['104'] = [charItem('100', '기존', '공허', '★4')];
  setServices({ wiki: new WikiClient({ fetcher: fakeFetcher(fx), retries: 0 }), srr: new SrrClient(noSrr) });
  const saved = process.env.CRON_SECRET;
  const savedHook = process.env.SYNC_WEBHOOK_URL;
  try {
    delete process.env.SYNC_WEBHOOK_URL;
    delete process.env.CRON_SECRET;
    assert.equal((await GET(new Request('https://x.test/api/cron/sync'))).status, 503);
    process.env.CRON_SECRET = 'correct-horse-battery-staple';
    assert.equal((await GET(new Request('https://x.test/api/cron/sync'))).status, 401);
    assert.equal((await GET(new Request('https://x.test/api/cron/sync', { headers: { authorization: 'Bearer wrong-secret-value-123456789' } }))).status, 401);
    assert.equal((await GET(new Request('https://x.test/api/cron/sync', { headers: { authorization: 'Bearer short' } }))).status, 401);
    const ok = await GET(new Request('https://x.test/api/cron/sync', { headers: { authorization: 'Bearer correct-horse-battery-staple' } }));
    assert.equal(ok.status, 200);
    const j: any = await ok.json();
    assert.equal(j.ok, true);
    assert.equal(j.webhook, 'webhook 미설정');
    assert.equal(j.report.current_counts.characters, 1);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
    if (savedHook !== undefined) process.env.SYNC_WEBHOOK_URL = savedHook;
  }
});
