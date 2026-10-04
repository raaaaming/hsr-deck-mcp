// 크론 동기화 결과의 선택적 후속 조치: 웹훅 알림, Vercel Deploy Hook 호출.
// 환경 변수/전송 함수/시계를 주입받아 테스트할 수 있게 분리했다.
import type { SyncReport } from './sync';

export type Env = Record<string, string | undefined>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function digest(report: SyncReport): string {
  const lines = [`[HSR 동기화] ${report.generated_at.slice(0, 16).replace('T', ' ')} UTC`, ...report.summary];
  const text = lines.join('\n');
  return text.length > 1800 ? text.slice(0, 1797) + '...' : text;
}

/** SYNC_WEBHOOK_URL이 있고 알릴 변화(needs_attention)가 있을 때만 요약을 POST한다(Discord는 content, Slack은 text 키를 읽는다). */
export async function notifyWebhook(report: SyncReport, env: Env, fetcher: Fetch): Promise<string> {
  const url = env.SYNC_WEBHOOK_URL;
  if (!url) return 'webhook 미설정';
  if (!report.needs_attention) return '알릴 변화 없음';
  try {
    const text = digest(report);
    const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }) });
    return `webhook ${res.status}`;
  } catch (e: any) {
    return `webhook 실패: ${e?.message ?? e}`;
  }
}

/**
 * SYNC_DEPLOY_HOOK_URL(Vercel Deploy Hook)이 있고, 새 항목이 있으며, 기준선이 20시간 넘게 묵었을 때만 재배포를 요청한다.
 * 재배포되면 prebuild(scripts/sync-data.ts)가 기준선(roster.json)을 현재 위키로 갱신하므로 같은 알림이 반복되지 않는다.
 * 빌드가 위키에 닿지 못해 기준선이 갱신되지 않아도 재배포는 하루 한 번을 넘지 않는다.
 */
export async function maybeRedeploy(report: SyncReport, env: Env, fetcher: Fetch, now = Date.now()): Promise<string> {
  const hook = env.SYNC_DEPLOY_HOOK_URL;
  if (!hook) return 'deploy hook 미설정';
  const fresh = report.new_characters.length + report.new_light_cones.length + report.new_relic_sets.length + report.became_ready.length;
  if (!fresh) return '재배포 불필요';
  const ageH = (now - Date.parse(report.baseline_generated)) / 3_600_000;
  if (!(ageH >= 20)) return `재배포 건너뜀: 기준선이 ${Number.isFinite(ageH) ? ageH.toFixed(1) : '?'}시간 전에 갱신됨(재배포 반복 방지)`;
  try {
    const res = await fetcher(hook, { method: 'POST' });
    return `재배포 요청 ${res.status}`;
  } catch (e: any) {
    return `재배포 요청 실패: ${e?.message ?? e}`;
  }
}
