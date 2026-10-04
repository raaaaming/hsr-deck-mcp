// 정규식 기반 경량 HTML 처리 (서버리스 환경에서 DOM 파서 없이 사용)

const NAMED: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  middot: '·',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  times: '×',
};

export function decodeEntities(input: string): string {
  let s = input;
  for (let i = 0; i < 2; i++) {
    const next = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
      if (g[0] === '#') {
        const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      const v = NAMED[g.toLowerCase()];
      return v === undefined ? m : v;
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * HTML → 평문. 태그를 먼저 제거한 뒤 엔티티를 해석하므로
 * "&lt;일반 공격&gt;" 같은 머리글은 "<일반 공격>" 문자열로 남는다.
 */
export function htmlToText(html: unknown): string {
  let s = String(html ?? '');
  if (!s) return '';
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0\u200b\u3000]+/g, ' ');
  s = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
    .join('\n');
  return s.replace(/\n{2,}/g, '\n').trim();
}

/** 한 줄 요약용: 줄바꿈을 공백으로 */
export function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** <table> → 행 × 셀(평문) */
export function parseTable(html: unknown): string[][] {
  const s = String(html ?? '');
  if (!s) return [];
  const rows: string[][] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(s))) {
    const cells: string[] = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = tdRe.exec(m[1]))) cells.push(htmlToText(c[1]).replace(/\n+/g, ' ').trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}
