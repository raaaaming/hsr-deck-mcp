# HSR Deck MCP — 붕괴: 스타레일 덱 빌딩용 MCP 서버

덱 빌딩 스킬(`hsr-deck-builder`)이 사용하는 **원격 MCP 서버**입니다. Vercel에 올리고, Claude에 “커스텀 커넥터”로 주소를 추가하면 스킬이 이 서버의 툴로 데이터를 읽고 계산합니다.

```
Claude(스킬) ──MCP(Streamable HTTP)──▶ https://<프로젝트>.vercel.app/mcp
                                          │
                  ┌───────────────────────┼───────────────────────────────┐
                  ▼                       ▼                               ▼
   HoYoWiki 내부 JSON API        StarRailRes(GitHub raw)        내장 계산기
   (목록·상세, 한국어)            소수점 기초치·에너지·성혼 레벨   스탯 합산 / 유물 롤 배분 / 행동수치(AV)
```

* **Playwright 없이** 위키 페이지가 내부적으로 쓰는 JSON API(`get_entry_page_list`, `entry_page`)를 직접 호출합니다. 헤더 `x-rpc-wiki_app: hsr`, `x-rpc-language: ko-kr`가 필요합니다.
* 위키는 캐릭터 94 / 광추 170 / 유물 세트 62(배포 시점 기준선) 규모이고, 새 항목은 **서버가 실시간으로 읽기 때문에 배포 없이도 바로 조회**됩니다.

## 1. 제공 툴

| 툴 | 용도 |
|---|---|
| `hsr_prepare_party` | 파티 표기(“은랑Lv.999(풀돌풀재), 펄(1돌,슈룸모험기)”)를 해석하고 멤버별 캐릭터·광추·계산 씨앗을 한 번에 반환 — **덱 빌딩의 첫 호출** |
| `hsr_parse_party` | 표기 해석만(가정·모호함 확인용) |
| `hsr_get_character` / `hsr_get_light_cone` / `hsr_get_relic_set` | 상세 조회 |
| `hsr_list_light_cones` / `hsr_list_relic_sets` | 운명의 길·희귀도·키워드로 필터 목록 |
| `hsr_search` | 이름 검색(약칭 가능) |
| `hsr_relic_rules` | 부위별 주옵션 후보·값, 부옵션 롤 값(하/중/상), 롤 개수 규칙 |
| `hsr_plan_relics` | 목표 스탯 하한을 지키면서 부옵션 롤 배분(부위 6 × 부옵션 롤 횟수)을 최적화 |
| `hsr_calc_build` | 기초 → 광추 → 행적 → 유물 주옵션/부옵션 → 최종 스탯 표(출처별 기여) |
| `hsr_simulate_turns` | 속도 기반 행동 순서(AV) 시뮬레이션, 앞당김/지연/속도 변화 이벤트 |
| `hsr_check_updates` | 신규 캐릭터·광추·유물, 새 캐릭터의 파싱 상태(ready/pending_data/needs_attention), 전용 광추 자동 추정 |
| `hsr_server_info` | 서버·기준선·보강 데이터 상태 |

## 2. Claude에 커넥터로 추가

Claude → **설정 → 커넥터 → 커스텀 커넥터 추가** → 이름(예: `HSR Deck`), URL `https://<프로젝트>.vercel.app/mcp`(키를 쓰면 `?key=<값>` 포함) → 추가.
Team/Enterprise 조직은 소유자가 조직 설정에서 먼저 추가해야 할 수 있습니다. 추가한 뒤 대화에서 커넥터를 켜면 `hsr_*` 툴이 보입니다.

## 3. 자동 업데이트(크론) — 새 캐릭터·광추·유물

`vercel.json`의 Vercel Cron이 매일 03:17 UTC(한국 12:17)에 `/api/cron/sync`를 호출합니다(Hobby 플랜은 하루 1회까지, 실행 시각은 ±1시간 오차가 있을 수 있습니다).

1. 위키 목록과 StarRailRes 캐시를 새로 읽습니다.
2. 배포 시점 기준선(`src/data/roster.json`)과 비교해 **새 캐릭터·광추·유물 세트**를 찾습니다.
3. 새 캐릭터는 실제로 파싱해 보고 `ready`(바로 사용 가능) / `pending_data`(위키에 아직 내용이 없음) / `needs_attention`(파서가 못 읽는 서식 — 확인 필요)으로 분류합니다.
4. 전용 광추 표에 없는 새 캐릭터는 위키의 추천 세팅(“전용 광추”)과 광추 출시 순서로 **자동 추정**합니다.
5. 결과는 응답 JSON과 함수 로그(`[hsr-sync]`)에 남고, 설정했다면 웹훅 알림·재배포 요청을 보냅니다.

같은 점검을 Claude에서 `hsr_check_updates` 툴로 언제든 실행할 수 있습니다.

## 4. 로컬 개발·테스트

```bash
npm install
npm test                 # 단위 테스트(스키마·계산기·유물 배분(정확해 대조)·시뮬레이터·표기 해석·성혼 레벨·동기화)
npx tsc --noEmit         # 타입 검사
npm run dev              # http://localhost:3000/mcp
npm run sync-data        # 기준선(roster.json)을 현재 위키로 갱신(수동)
```

디버그용 직접 호출: `POST /api/call` `{ "tool": "hsr_search", "args": { "query": "펄" } }` (키를 설정했다면 `?key=` 필요).

## 5. 문제 해결

* **`/mcp`가 401 + “Authentication Required” HTML** — Vercel의 Deployment Protection입니다. 프로덕션 주소(`프로젝트명.vercel.app`)를 쓰거나 Project → Settings → Deployment Protection에서 Vercel Authentication을 끄세요.
* **`/mcp`가 401 JSON(`unauthorized`)** — `MCP_ACCESS_KEY`를 설정했는데 커넥터 주소에 `?key=`가 없거나 틀린 경우입니다.
* **툴이 “위키 요청 실패: HTTP 403/429”** — HoYoLAB이 해당 지역 IP를 거절/제한한 경우입니다. `vercel.json`의 `regions`(기본 `sin1`)를 `hnd1`(도쿄), `iad1`(워싱턴) 등으로 바꿔 재배포해 보세요. 서버는 같은 메뉴를 6시간, 새로고침은 5분에 한 번만 읽도록 캐시합니다.
* **“캐릭터를 찾지 못함”** — 신규 캐릭터일 수 있습니다. 서버가 목록을 새로 읽어 한 번 더 찾지만, 위키에 내용이 아직 비어 있으면 `pending_data`로 표시됩니다.
* **빌드 로그의 `[sync-data] 위키 요청 실패`** — 빌드 서버에서 위키에 닿지 않았다는 뜻이며 빌드는 기존 기준선으로 계속 진행됩니다(정상).

## 6. 데이터 출처와 한계

* 위키(HoYoWiki, 한국어): 이름·운명의 길·속성·희귀도·스킬/행적/성혼 텍스트·스킬 레벨 표·광추 패시브·유물 세트 효과. 기초 능력치는 **정수 내림값**이라 ±1~3 오차가 있습니다.
* StarRailRes(GitHub): 소수점 기초치(Lv.80)·에너지 비용·성혼 스킬 레벨 보너스(위키 오기재 자동 교정)·작은 행적 수치 보완. 서버에서 닿지 않으면 위키 값만 쓰고 그 사실을 응답에 표시합니다.
* 전용 광추 표(`src/data/signature.json`)는 69쌍을 StarRailRes의 운명의 길로 교차 검증한 값이며, 새 캐릭터는 자동 추정합니다.
* 유물 롤 계획은 **평균 롤**(최소값 + 단계 폭) 기준입니다. 실제 아이템은 롤 편차가 있으므로 결과에 “상위 롤이면 여유” 같은 해석 여지를 둡니다.
