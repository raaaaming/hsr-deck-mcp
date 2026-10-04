import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleOf, simulateTurns } from '../src/lib/turns';

const order = (r: ReturnType<typeof simulateTurns>, n = 99) => r.timeline.slice(0, n).map((e) => e.actor);
const close = (a: number, b: number, eps = 0.011) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('행동 수치: 속도 160/134/120의 행동 순서와 AV', () => {
  const r = simulateTurns({ units: [{ name: 'A', spd: 160 }, { name: 'B', spd: 134 }, { name: 'C', spd: 120 }], max_av: 200 });
  assert.deepEqual(order(r), ['A', 'B', 'C', 'A', 'B', 'C', 'A']);
  close(r.timeline[0].av, 62.5);
  close(r.timeline[1].av, 74.63);
  close(r.timeline[2].av, 83.33);
  close(r.timeline[3].av, 125);
  close(r.timeline[4].av, 149.25);
  close(r.timeline[5].av, 166.67);
  close(r.timeline[6].av, 187.5);
});

test('사이클 경계: 0사이클=0~150AV, 이후 100AV마다', () => {
  assert.equal(cycleOf(0), 0);
  assert.equal(cycleOf(150), 0);
  assert.equal(cycleOf(150.01), 1);
  assert.equal(cycleOf(250), 1);
  assert.equal(cycleOf(250.01), 2);
  assert.equal(cycleOf(450), 3);
  const r = simulateTurns({ units: [{ name: 'A', spd: 160 }], max_av: 450 });
  const per = Object.fromEntries(r.per_cycle.map((c) => [c.cycle, c.actions.A]));
  // 0사이클(≤150): 62.5, 125 / 1사이클(≤250): 187.5, 250 / 2사이클(≤350): 312.5 / 3사이클(≤450): 375, 437.5
  assert.deepEqual(per, { 0: 2, 1: 2, 2: 1, 3: 2 });
});

test('행동 앞당김: 100% 앞당기면 즉시 다음에 행동한다', () => {
  const r = simulateTurns({
    units: [{ name: 'A', spd: 160 }, { name: 'B', spd: 100 }],
    events: [{ after: { actor: 'A', nth: 1 }, target: 'B', kind: 'advance', value: 100, note: 'B 100% 앞당김' }],
    max_av: 130,
  });
  assert.deepEqual(order(r), ['A', 'B', 'A']);
  close(r.timeline[1].av, 62.5);
  assert.ok(r.timeline[0].notes.includes('B 100% 앞당김'));
});

test('행동 지연: 남은 거리가 늘어난다(최대 10000)', () => {
  const r = simulateTurns({
    units: [{ name: 'A', spd: 200 }, { name: 'B', spd: 100 }],
    events: [{ after: { actor: 'A', nth: 1 }, target: 'B', kind: 'delay', value: 50 }],
    max_av: 120,
  });
  // A 50 AV에 행동 → B 남은 거리 5000+5000=10000 → B는 50+100=150 AV (그 전에는 A만 50, 100AV에 행동)
  assert.deepEqual(order(r), ['A', 'A']);
  const r2 = simulateTurns({ units: [{ name: 'A', spd: 200 }, { name: 'B', spd: 100 }], events: [{ after: { actor: 'A', nth: 1 }, target: 'B', kind: 'delay', value: 50 }], max_av: 160 });
  const b = r2.timeline.find((e) => e.actor === 'B')!;
  close(b.av, 150);
});

test('속도 변화: 남은 거리는 보존된 채 새 속도로 이어 달린다', () => {
  const r = simulateTurns({
    units: [{ name: 'X', spd: 100 }, { name: 'Y', spd: 200 }],
    events: [{ after: { actor: 'Y', nth: 1 }, target: 'X', kind: 'spd_pct', value: 100 }],
    max_av: 80,
  });
  // Y 50AV: X 남은 5000 → 속도 200 → 25AV 뒤인 75AV에 행동
  const x = r.timeline.find((e) => e.actor === 'X')!;
  close(x.av, 75);
  close(x.spd, 200);
});

test('속도 효과 지속 시간: 대상의 행동 횟수로 센다', () => {
  const r = simulateTurns({
    units: [{ name: 'X', spd: 100 }, { name: 'Y', spd: 200 }],
    events: [{ after: { actor: 'Y', nth: 1 }, target: 'X', kind: 'spd_add', value: 100, duration: 2 }],
    max_av: 260,
  });
  const xs = r.timeline.filter((e) => e.actor === 'X').map((e) => e.av);
  close(xs[0], 75); // 버프 후 첫 행동
  close(xs[1], 125); // 버프 유지(2번째)
  close(xs[2], 225); // 버프 종료 → 원래 속도 100
});

test('동속 우선순위: 입력 순서 또는 priority가 낮은 쪽이 먼저', () => {
  const a = simulateTurns({ units: [{ name: 'A', spd: 100 }, { name: 'B', spd: 100 }], max_av: 100 });
  assert.deepEqual(order(a), ['A', 'B']);
  const b = simulateTurns({ units: [{ name: 'A', spd: 100, priority: 5 }, { name: 'B', spd: 100, priority: 1 }], max_av: 100 });
  assert.deepEqual(order(b), ['B', 'A']);
});

test('전투 시작 앞당김: 시작 시 앞당김%만큼 첫 행동이 빨라진다', () => {
  const r = simulateTurns({ units: [{ name: 'A', spd: 100, start_advance_pct: 40 }, { name: 'B', spd: 120 }], max_av: 90 });
  close(r.first_actions_av.A, 60);
  close(r.first_actions_av.B, 83.33);
});

test('존재하지 않는 유닛을 가리키는 이벤트는 경고한다', () => {
  const r = simulateTurns({ units: [{ name: 'A', spd: 100 }], events: [{ after: { actor: 'Z', nth: 1 }, target: 'A', kind: 'advance', value: 50 }], max_av: 120 });
  assert.ok(r.warnings.some((w) => w.includes('"Z"')));
});
