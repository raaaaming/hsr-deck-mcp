import { NextResponse } from 'next/server';
import { isAuthorized } from '../../../src/lib/access';
import { TOOLS, services } from '../../../src/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** 디버그/자동화용 직접 호출 엔드포인트: POST /api/call  { "tool": "hsr_search", "args": { "query": "펄" } }
 *  환경변수 MCP_ACCESS_KEY(또는 HSR_API_KEY)가 설정되어 있으면 ?key= / Authorization: Bearer / x-api-key 로 키가 필요하다. */
function authorized(req: Request): boolean {
  return isAuthorized(req);
}

async function run(tool: string, args: unknown) {
  const def = TOOLS.find((t) => t.name === tool);
  if (!def) return NextResponse.json({ ok: false, error: `알 수 없는 툴: ${tool}`, tools: TOOLS.map((t) => t.name) }, { status: 404 });
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid args', issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, result: await def.run(parsed.data, services()) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  return run(String(body.tool ?? ''), body.args);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const u = new URL(req.url);
  let args: unknown = {};
  try {
    args = JSON.parse(u.searchParams.get('args') ?? '{}');
  } catch {
    return NextResponse.json({ ok: false, error: 'args must be JSON' }, { status: 400 });
  }
  return run(u.searchParams.get('tool') ?? '', args);
}
