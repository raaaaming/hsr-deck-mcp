import { TOOLS } from '../src/lib/tools';

export const dynamic = 'force-static';

export default function Home() {
  return (
    <main>
      <h1>HSR Deck MCP</h1>
      <p>붕괴: 스타레일 덱 빌딩 스킬이 사용하는 MCP 서버입니다. HoYoWiki의 내부 JSON API에서 캐릭터·광추·유물 데이터를 읽고, 스탯 합산·유물 롤 배분·행동 수치(AV) 계산을 제공합니다.</p>
      <ul>
        <li>MCP 엔드포인트: <code>/mcp</code> (Streamable HTTP) — Claude에서는 “커스텀 커넥터”로 이 주소를 추가하세요.</li>
        <li>상태 확인: <a href="/api/health">/api/health</a> · 위키 연결 점검: <a href="/api/health?deep=1">/api/health?deep=1</a></li>
        <li>
          자동 동기화(Vercel Cron, 매일 1회): <code>/api/cron/sync</code> — 새 캐릭터·광추·유물 세트를 감지하고 파서 상태를 점검하며 전용 광추를 추정합니다(<code>CRON_SECRET</code> 필요). 같은 점검을 MCP 툴{' '}
          <code>hsr_check_updates</code>로도 실행할 수 있습니다.
        </li>
      </ul>
      <h2>제공 툴</h2>
      <ul>
        {TOOLS.map((t) => (
          <li key={t.name}>
            <code>{t.name}</code> — {t.title}
          </li>
        ))}
      </ul>
    </main>
  );
}
