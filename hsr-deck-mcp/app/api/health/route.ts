import { NextResponse } from 'next/server';
import { TOOLS, services } from '../../../src/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET /api/health            → 서버 생존 확인
 *  GET /api/health?deep=1     → 위키(HoYoWiki) 접속/목록 개수까지 점검 (Vercel→hoyolab 연결 진단용) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = { ok: true, time: new Date().toISOString(), tools: TOOLS.map((t) => t.name) };
  if (url.searchParams.get('deep') !== '1') return NextResponse.json(base);
  const t0 = Date.now();
  try {
    const svc = services();
    const [c, l, r] = await Promise.all([svc.wiki.listAll('104'), svc.wiki.listAll('107'), svc.wiki.listAll('108')]);
    const srr = await svc.srr.load();
    return NextResponse.json({
      ...base,
      wiki: { characters: c.length, light_cones: l.length, relic_sets: r.length, ms: Date.now() - t0 },
      starrailres: !!srr,
    });
  } catch (e: any) {
    return NextResponse.json({ ...base, ok: false, error: String(e?.message ?? e), ms: Date.now() - t0 }, { status: 502 });
  }
}
