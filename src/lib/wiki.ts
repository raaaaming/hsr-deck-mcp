// HoYoWiki(HSR) 내부 JSON API 클라이언트.
// Playwright 대신 위키 페이지가 내부적으로 호출하는 JSON 엔드포인트를 직접 사용한다.
//  - 목록: POST get_entry_page_list  (menu_id 104=캐릭터, 107=광추, 108=유물)
//  - 상세: GET  entry_page?entry_page_id=ID
// 반드시 x-rpc-wiki_app: hsr 헤더가 있어야 한다(없으면 다른 게임의 항목이 반환됨).

import { AsyncCache, sleep } from './util';

export type MenuId = '104' | '107' | '108';
export const MENU = { character: '104', light_cone: '107', relic: '108' } as const;

export interface ListItem {
  entry_page_id: string;
  name: string;
  icon_url?: string;
  display_field?: Record<string, any>;
  filter_values?: Record<string, { values?: string[] }>;
  desc?: string;
}

export interface EntryPage {
  id: string;
  name: string;
  menu_id?: string;
  menu_name?: string;
  desc?: string;
  filter_values?: Record<string, { values?: string[] }>;
  modules: { name: string; components: { component_id: string; data: string }[] }[];
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface WikiClientOptions {
  fetcher?: Fetcher;
  language?: string;
  ttlMs?: number;
  retries?: number;
}

const LIST_URL = 'https://sg-wiki-api.hoyolab.com/hoyowiki/hsr/wapi/get_entry_page_list';
const ENTRY_HOSTS = [
  'https://sg-wiki-api-static.hoyolab.com/hoyowiki/hsr/wapi/entry_page',
  'https://sg-wiki-api.hoyolab.com/hoyowiki/hsr/wapi/entry_page',
];
const PAGE_SIZE = 50; // 100은 retcode 100010으로 거부됨

export class WikiClient {
  private fetcher: Fetcher;
  private lang: string;
  private retries: number;
  private listCache: AsyncCache<ListItem[]>;
  private entryCache: AsyncCache<EntryPage>;

  constructor(opts: WikiClientOptions = {}) {
    this.fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
    this.lang = opts.language ?? 'ko-kr';
    this.retries = opts.retries ?? 3;
    const ttl = opts.ttlMs ?? 6 * 60 * 60 * 1000;
    this.listCache = new AsyncCache(ttl, 12);
    this.entryCache = new AsyncCache(ttl, 400);
  }

  private headers(json = false): Record<string, string> {
    return {
      'x-rpc-language': this.lang,
      'x-rpc-wiki_app': 'hsr',
      accept: 'application/json, text/plain, */*',
      origin: 'https://wiki.hoyolab.com',
      referer: 'https://wiki.hoyolab.com/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async json<T = any>(url: string, init: RequestInit): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetcher(url, init);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        const j = (await res.json()) as any;
        if (j?.retcode !== 0) {
          throw Object.assign(new Error(`retcode ${j?.retcode} ${j?.message ?? ''}`.trim()), { fatal: true });
        }
        return j as T;
      } catch (e: any) {
        lastErr = e;
        if (e?.fatal) break;
        await sleep(350 * 2 ** attempt);
      }
    }
    throw new Error(`위키 요청 실패: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  /** 메뉴 전체 목록(50개씩 페이지네이션) */
  listAll(menu: MenuId): Promise<ListItem[]> {
    return this.listCache.get(menu, async () => {
      const out: ListItem[] = [];
      let total = Infinity;
      for (let page = 1; out.length < total && page <= 12; page++) {
        const j = await this.json<{ data: { list: ListItem[]; total: string | number } }>(LIST_URL, {
          method: 'POST',
          headers: this.headers(true),
          body: JSON.stringify({ filters: [], menu_id: menu, page_num: page, page_size: PAGE_SIZE, use_es: true }),
        });
        const list = j.data?.list ?? [];
        total = Number(j.data?.total ?? list.length);
        if (!list.length) break;
        out.push(...list);
      }
      return out;
    });
  }

  private lastForced = new Map<string, number>();

  /**
   * 목록 캐시를 무시하고 다시 읽는다(새 캐릭터·광추·유물이 위키에 추가됐는지 확인할 때).
   * 위키를 두드리지 않도록 같은 메뉴는 minIntervalMs 안에 한 번만 실제로 갱신한다(그 안이면 기존 캐시를 그대로 돌려줌).
   */
  refreshList(menu: MenuId, minIntervalMs = 5 * 60_000): Promise<ListItem[]> {
    const last = this.lastForced.get(menu) ?? 0;
    if (Date.now() - last >= minIntervalMs) {
      this.lastForced.set(menu, Date.now());
      this.listCache.delete(menu);
    }
    return this.listAll(menu);
  }

  /** 항목 상세 */
  getEntry(id: string | number): Promise<EntryPage> {
    const key = String(id);
    return this.entryCache.get(key, async () => {
      let lastErr: unknown;
      for (const host of ENTRY_HOSTS) {
        try {
          const j = await this.json<{ data: { page: EntryPage } }>(`${host}?entry_page_id=${encodeURIComponent(key)}`, {
            method: 'GET',
            headers: this.headers(),
          });
          const page = j.data?.page;
          if (!page || !Array.isArray(page.modules)) throw new Error('빈 응답');
          return page;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    });
  }

  /** 여러 항목을 제한된 동시성으로 */
  async getEntries(ids: (string | number)[], concurrency = 6): Promise<EntryPage[]> {
    const out: EntryPage[] = new Array(ids.length);
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const k = i++;
        out[k] = await this.getEntry(ids[k]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    return out;
  }

  clearCache() {
    this.listCache.clear();
    this.entryCache.clear();
    this.lastForced.clear();
  }
}

/** 컴포넌트 data(JSON 문자열)를 파싱해 반환 */
export function component<T = any>(page: EntryPage, id: string, nth = 0): T | null {
  const comps = page.modules.flatMap((m) => m.components).filter((c) => c.component_id === id);
  const c = comps[nth];
  if (!c || !c.data) return null;
  try {
    return JSON.parse(c.data) as T;
  } catch {
    return null;
  }
}

export function fv(item: { filter_values?: Record<string, { values?: string[] }> }, key: string): string[] {
  return item.filter_values?.[key]?.values ?? [];
}
