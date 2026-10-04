import { createMcpHandler } from 'mcp-handler';
import { isAuthorized, unauthorizedResponse } from '../../src/lib/access';
import { TOOLS, services, toContent } from '../../src/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    for (const t of TOOLS) {
      server.registerTool(
        t.name,
        { title: t.title, description: t.description, inputSchema: t.input },
        async (args: any) => {
          try {
            const result = await t.run(args ?? {}, services());
            return { content: toContent(result) };
          } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `오류: ${e?.message ?? String(e)}` }], isError: true };
          }
        },
      );
    }
  },
  {
    serverInfo: { name: 'hsr-deck-mcp', version: '0.1.0' },
    verboseLogs: false,
  },
);

// MCP_ACCESS_KEY가 설정된 경우에만 키를 요구한다(src/lib/access.ts)
const guarded = (req: Request) => (isAuthorized(req) ? handler(req) : unauthorizedResponse());

export { guarded as GET, guarded as POST, guarded as DELETE };
