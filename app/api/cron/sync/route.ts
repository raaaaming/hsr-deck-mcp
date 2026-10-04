import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { maybeRedeploy, notifyWebhook } from '../../../../src/lib/notify';
import { runSync } from '../../../../src/lib/sync';
import { services } from '../../../../src/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron이 매일 호출하는 동기화 점검.
 *  - 위키 목록/StarRailRes 캐시를 새로 읽고, 배포 시점 기준선(src/data/roster.json)과 비교해 신규 캐릭터·광추·유물 세트를 찾는다.
 *  - 새 캐릭터를 실제로 파싱해 보고(ready / pending_data / needs_attention), 표에 없는 전용 광추를 자동 추정한다.
 *  - 결과는 응답 JSON과 함수 로그(`[hsr-sync]`)에 남고, 선택적으로 웹훅 알림·재배포 요청을 보낸다.
 *
 * 인증: Vercel은 환경 변수 CRON_SECRET이 있으면 크론 호출에 `Authorization: Bearer <CRON_SECRET>`를 붙인다.
 * CRON_SECRET이 없으면 누구나 위키/GitHub를 두드리게 만들 수 있으므로 엔드포인트를 닫아 둔다(503).
 *
 * 선택 환경 변수
 *  - SYNC_WEBHOOK_URL      새 항목/이상 징후가 있을 때 요약을 POST({content, text}: Discord·Slack 호환)
 *  - SYNC_DEPLOY_HOOK_URL  새 항목이 있고 기준선이 20시간 넘게 묵었을 때 Vercel Deploy Hook을 호출(재배포 → prebuild가 기준선 갱신)
 */
function authorize(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, status: 503, error: 'CRON_SECRET 환경 변수가 설정되지 않아 이 엔드포인트를 닫아 두었습니다. Vercel 프로젝트의 Environment Variables에 CRON_SECRET(임의의 긴 문자열)을 추가하고 재배포하세요.' };
  }
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    const report = await runSync(services(), { forceRefresh: true });
    console.log('[hsr-sync]', JSON.stringify({ at: report.generated_at, needs_attention: report.needs_attention, summary: report.summary }));
    const [webhook, redeploy] = await Promise.all([notifyWebhook(report, process.env, fetch), maybeRedeploy(report, process.env, fetch)]);
    return NextResponse.json({ ok: true, webhook, redeploy, report });
  } catch (e: any) {
    console.error('[hsr-sync] failed', e?.message ?? e);
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 502 });
  }
}

export const POST = GET;
