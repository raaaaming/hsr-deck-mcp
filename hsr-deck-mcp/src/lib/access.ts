// 선택적 접근 키: MCP_ACCESS_KEY(또는 이전 이름 HSR_API_KEY)가 설정되어 있으면 /mcp, /api/call 호출에 키가 필요하다.
// Claude의 커스텀 커넥터는 URL만 입력받으므로 커넥터 주소에 ?key=값 을 붙여 쓰는 방식을 기본으로 한다
// (Authorization: Bearer 값, x-api-key 헤더도 허용). 키가 없으면 누구나 호출 가능(공개 위키 데이터만 다룸).
import { timingSafeEqual } from 'node:crypto';

export function accessKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.MCP_ACCESS_KEY || env.HSR_API_KEY || null;
}

export function isAuthorized(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  const key = accessKey(env);
  if (!key) return true;
  const url = new URL(req.url);
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const given = [url.searchParams.get('key'), bearer, req.headers.get('x-api-key')].filter((v): v is string => !!v);
  const want = Buffer.from(key);
  return given.some((g) => {
    const b = Buffer.from(g);
    return b.length === want.length && timingSafeEqual(b, want);
  });
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized', hint: '이 서버는 접근 키가 필요합니다. 커넥터 주소 끝에 ?key=<MCP_ACCESS_KEY> 를 붙이세요.' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
