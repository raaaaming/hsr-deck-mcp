// 공용 유틸리티 (외부 의존성 없음)

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 이름 비교용 정규화: NFKC, 소문자, 공백/구두점/기호 제거 */
export function normName(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{Cf}\p{Cc}\u318d\u119e]+/gu, ''); // NFKC가 U+318D를 U+119E로 바꾸므로 둘 다 제거
}

export const r2 = (n: number, d = 2): number => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** "1,234.5%" → 1234.5 (실패 시 null) */
export function toNum(s: unknown): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

/** TTL + 진행중 요청 중복제거 캐시 */
export class AsyncCache<T> {
  private m = new Map<string, { t: number; p: Promise<T> }>();
  constructor(private ttlMs: number, private max = 600) {}
  get(key: string, make: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.m.get(key);
    if (hit && now - hit.t < this.ttlMs) return hit.p;
    const p = make().catch((e) => {
      if (this.m.get(key)?.p === p) this.m.delete(key);
      throw e;
    });
    this.m.set(key, { t: now, p });
    if (this.m.size > this.max) {
      const k = this.m.keys().next().value;
      if (k !== undefined) this.m.delete(k);
    }
    return p;
  }
  clear() {
    this.m.clear();
  }
  delete(key: string) {
    this.m.delete(key);
  }
  size() {
    return this.m.size;
  }
}

/** 결정적 난수 (재현 가능한 계획 탐색용) */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
