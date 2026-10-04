// 현재 위키 목록으로 기준선(src/data/roster.json)을 다시 만든다.
//   npm run sync-data            수동 실행(실패하면 오류 종료)
//   npm run sync-data -- --report  기준선은 그대로 두고 신규 항목 점검 결과만 출력
//   prebuild(--soft)             Vercel 빌드마다 자동 실행 — 위키에 닿지 않거나 결과가 이상하면 기존 파일을 그대로 두고 통과
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WikiClient } from '../src/lib/wiki';
import { SrrClient } from '../src/lib/enrich';
import { BASELINE, buildRoster, runSync } from '../src/lib/sync';

const soft = process.argv.includes('--soft');
const reportOnly = process.argv.includes('--report');
const file = resolve(process.cwd(), 'src/data/roster.json');

async function main() {
  if (process.env.SKIP_SYNC_DATA === '1') {
    console.log('[sync-data] SKIP_SYNC_DATA=1 — 건너뜀');
    return;
  }
  const fetcher = (u: string, i?: RequestInit) => fetch(u, { ...i, signal: AbortSignal.timeout(12_000) });
  const wiki = new WikiClient({ fetcher, retries: 1 });
  const srr = new SrrClient(fetcher);

  if (reportOnly) {
    const report = await runSync({ wiki, srr }, { forceRefresh: true });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const next = await buildRoster({ wiki, srr });
  const prevCount = Object.keys(BASELINE.characters).length + Object.keys(BASELINE.light_cones).length + Object.keys(BASELINE.relics).length;
  const nextCount = Object.keys(next.characters).length + Object.keys(next.light_cones).length + Object.keys(next.relics).length;
  if (nextCount < prevCount * 0.9) throw new Error(`목록이 비정상적으로 작음(${nextCount} < ${prevCount}의 90%) — 위키 응답 이상으로 보고 기준선을 갱신하지 않습니다`);

  const old = JSON.parse(readFileSync(file, 'utf8'));
  const out = { _comment: old._comment, ...next };
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`[sync-data] roster.json 갱신: 캐릭터 ${Object.keys(next.characters).length}, 광추 ${Object.keys(next.light_cones).length}, 유물 ${Object.keys(next.relics).length}, 대기(pending) ${next.pending.length}`);
}

const guard = setTimeout(() => {
  console.error('[sync-data] 시간 초과');
  process.exit(soft ? 0 : 1);
}, 45_000);
guard.unref();

main().catch((e) => {
  console.error('[sync-data]', e?.message ?? e);
  process.exit(soft ? 0 : 1);
});
