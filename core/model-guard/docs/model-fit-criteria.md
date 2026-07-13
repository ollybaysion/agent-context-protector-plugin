# Model-Advisor 판정 기준 재설계 — 2티어 최근성 + 가드 (설계)

> **상태**: 제안(설계). 구현 대기. 확정 시 [`../DESIGN.md`](../DESIGN.md) §4.3의 판정
> 로직을 대체한다. statusline·상태파일 형태·자기소거(§4.5)는 **무변경**.
> **근거**: 실 트랜스크립트 대상 조사·설계 워크플로우(에이전트 12, 2026-07-08) + 독립
> 적대검증 패널(에이전트 5, 2026-07-10).
> **리비전 2 (2026-07-10)**: 적대 패널이 초판의 헤드라인 검증("무거운 세션 100% 작업형")을
> **반증**했다 — 그 수치는 조용한 세션 4개만 고른 결과였고, 전 코퍼스 재현 시 오발화가
> 나온다(§0·§12). 정정: **티어1 게이트를 최근 4턴 → 전체 창(12턴)으로 확대**(§4, 하중
> 정정)하고, toolShareFloor·§9의 근거 서술을 코퍼스 실측으로 교정했다. 아키텍처·결론
> (넛지 수용, keepOnThinking 기본 OFF)은 유지된다.

---

## 0. 요약

model-advisor가 "현재 모델이 이 작업에 과한가"를 판정하는 기준을, 현행 "최근 8개
assistant 엔트리 중 light 6개" 휴리스틱에서 **논리 턴 기반 2티어 판정**으로 바꾼다.
현행 기준은 실측으로 두 군데가 깨져 있었다(§1).

**검증 실태(정정, 전 코퍼스)**: 초판은 "무거운 세션 4개 → 100% 작업형"이라 주장했으나,
그 4개(`d6ed1003`/`099c99db`/`f9b16ade`/`6f34b83c`)는 조용한 세션(0~2% 발화)만 고른
것이었다. **전 코퍼스 매 Stop 재현** 결과, 초판 기본값에선 36개 고비용 세션 중 **8개가
다운그레이드를 발화**했고 그중 7개가 무거운 엔지니어링 세션(최대 32%: `628823da` 13/41,
`b1e2ab6b` 8/34 등) — 즉 **재설계가 없애려던 "작업 중 거짓 넛지" 버그가 재발**했다.
근본 원인: `recentK=4`가 짧아 무거운 세션의 설명 스트릭에서 작업 턴을 못 짚었고,
"toolShare가 0.22 vs ≥0.57로 갈린다"는 수치는 **세션 전체 통계**라 훅이 실제 쓰는 12턴
창에선 무너진다. **하중 정정**: 티어1 게이트를 **전체 창(12턴)에 작업 턴 하나라도**로
넓히면 무거운 오발화 34→8건·7→2세션. **§9 결정(확정, Red-Green 게이트로 종결): 비구현
버킷엔 다운그레이드를 아예 안 띄운다** — 게이트가 그 버킷을 20 설계 : 0 단순질문으로
실증(단순질문 vs 설계 판별 불가). model-advisor는 실질적으로 작업 모드 표시로 축소되고,
구현 라우팅(toolShare)만 살린다. 이 결정은 `test/model-fit-gate.test.mjs`에 회귀로 고정.

---

## 1. 왜 — 현행 기준의 실증적 파산

현행 판정(DESIGN.md §4.3):

```text
light 턴 = tool_use ≤ 1개 AND 무거운 도구(Edit/Write/Task/…) 없음
최근 8개 assistant 엔트리 중 light ≥ 6 → 대화형 → 다운그레이드 권고
```

실 트랜스크립트 채굴로 드러난 두 결함:

- **(A) 블록 쪼개짐 = 근본 원인.** CC 트랜스크립트는 **한 JSONL 줄에 content 블록이
  하나씩** 들어간다(실측 1164/1164). 그래서 "최근 8개 엔트리"는 8개 논리 턴이 아니라
  8개 **블록 조각**이다. 무거운 편집 턴 하나가 `[thinking]`·`[text]`·`[Edit]` 세 줄로
  쪼개지고, thinking·text 조각이 light로 집계된다. 실측: 1164 엔트리 → 549 논리 턴
  (**2.12배 인플레**). 이게 "구현 중인데 대화형"의 진짜 원인이다.
- **(B) `tool_use ≤ 1` 조건은 죽은 코드.** 엔트리당 블록이 하나뿐이라 `tool_use ≥ 2`인
  엔트리가 **0건**. 즉 light 판정은 사실상 "무거운 도구 없음"만 검사해 왔다.
- **(C) Bash 사각지대(2차 요인).** 무거운 도구 목록에 Bash가 없어, 실제 엔지니어링
  작업의 상당량(`git`/`npm test`/`gh`/빌드)이 light로 샌다.

부차적 실패모드: 무거운 버스트가 8칸 창에서 금방 밀려남(스크롤아웃), 긴 설명 텍스트
턴이 창을 지배, mixed-model 창, `[1m]` 접미사, 컴팩션 직후 꼬리.

---

## 2. 새 기준 개요 — 2티어

3단계로 판정한다.

1. **논리 턴 복원**: 같은 `message.id`의 (assistant-필터된) 엔트리를 한 턴으로 묶는다
   (인플레 해소). `isSidechain`·`<synthetic>` 제외.
2. **턴 분류**: 각 논리 턴을 작업 턴 / 텍스트 턴 / (조회 도구만 쓴) 중립 턴으로.
3. **2티어 판정**:
   - **티어 1 — 작업 게이트(지배적)**: **전체 창(`recentK` = `chatWindow` = 12턴)** 에 작업
     턴이 **하나라도** 있으면 → 작업형. 즉시 확정. (초판의 최근 4턴에서 확대 — §4·§0.)
   - **티어 2 — 지속 대화**: 창에 작업 턴이 **전무**할 때만. 턴 수·툴 비율 문턱을 넘으면
     대화형 → 다운그레이드. 이 칸만 권고를 낸다.

---

## 3. 신호 정의 — 트랜스크립트 꼬리에서 계산

전부 `readTail(path, 262144)`(파일 끝 ~256KB seek-read)에서 나온다. 검증된 필드:
assistant 엔트리 `type==="assistant"` / `message.role==="assistant"`; `message.id`;
`message.model`; `message.content[]`(블록 `.type ∈ {text, thinking, tool_use}`, tool
블록에 `.name`·`.input.command`·`.input.file_path`). tool 결과는 **user** 엔트리의
`content[].type==="tool_result"`(`.is_error` 선택)로 온다.

**S0 — 논리 턴 그룹화(핵심 활성화 요소).** 같은 `message.id` 엔트리를 한 논리 턴으로
합친다. **주의(적대검증 정정)**: 같은 id 줄은 **raw 줄 기준으로는 연속이 아닐 수 있다** —
tool_use assistant 엔트리와 그 continuation 사이에 user `tool_result` 엔트리가 끼어
들어가 raw-줄로는 끊긴 id-그룹이 실측 90/1820건 있었다. 그러므로 그룹화는 **user 엔트리를
먼저 걸러낸 assistant-필터 스트림 위에서** 같은 id를 이어붙여야 한다(naive raw-consecutive
구현은 턴을 파편화한다). `id` 없으면 그 엔트리 자체가 한 턴(fail-open; 실측 0%).

턴별 계산:

| 신호 | 정의 |
| --- | --- |
| `hasTool` | 블록에 `type==="tool_use"` 하나라도 |
| `textOnly` | `!hasTool` |
| `hasThinking` | 블록에 `type==="thinking"` 하나라도(존재만 — `.thinking` 본문은 트랜스크립트에서 삭제됨, 863/863 빈 문자열) |
| `isWork`(**strict**) | `name ∈ Edit\|Write\|MultiEdit\|Task\|Agent\|Workflow\|NotebookEdit` 인 tool_use, **또는** (`name==="Bash"` AND `isWorkBash(input.command)`) |
| `model` | 그 턴의 `message.model` |

**S3 — 엔지니어링 Bash 분류(1차 사각지대 수정).** `lib/patterns.mjs`의
`bashPattern(command)`을 재사용한다(셸 재파싱 금지). 패밀리 라벨 머리가 순수 조회
도구인 경우만 비작업으로 보는 **trivial 거부목록** — 즉 변경·빌드·테스트는 기본 작업:

```text
TRIVIAL_BASH = /^(cat|ls|cd|echo|pwd|head|tail|wc|which|type|rg|grep|fd|find|sed|awk|
                  sort|uniq|cut|tr|env|export|true|false|sleep|date|whoami|realpath|
                  dirname|basename|stat|file|tree|jq|diff|column|xargs)$/
isWorkBash(cmd) = !TRIVIAL_BASH.test(bashPattern(cmd).split(" ")[0])
```

`git commit`·`npm test`·`cargo build`·`gh pr create`·`make`·`node x.mjs`·`pytest`·
`tsc` → 작업. bare `rg`/`cat`/`ls` → 조회(비작업). 단 조회 Bash도 `hasTool`이라, 조사
스트릭이 티어 2에서 대화형으로 새지 않는다.

**알려진 비대칭(의도적 보수)**: `bashPattern`은 서브커맨드를 라벨 머리로 내므로 읽기 전용
`git status|diff|log|show` 와 `gh pr view`/`gh issue list` 는 머리가 `git`/`gh`라 **작업으로**
분류된다(bare `diff`/`cat`은 trivial). 즉 창에 `git status` 하나만 있어도 대화 스트릭이
작업형으로 고정된다 — **넛지 억제 방향**이라 과발화(§0) 대비 안전해서 그대로 둔다. 더
공격적으로 잡고 싶으면 `git/gh`의 읽기 서브커맨드(`status|diff|log|show|branch|view|list`)를
trivial 집합에 추가하는 튜닝 여지를 남긴다.

**S5 — 창 수준 파생 신호**(scoped 창 위에서):

- `toolShare = count(hasTool) / kept.length` — **창 수준의 약한 2차 신호**(하중 신호는 티어1
  게이트, §4·§8 참조).
- `struggled = anyError || repeatEdit` — `anyError`는 창 구간의 user
  `tool_result.is_error===true` 존재, `repeatEdit`는 한 `file_path`가 `repeatEditN`회
  이상 Edit/Write/MultiEdit. **주의: `is_error`는 user 엔트리에만 있다**(§11).
- `textOnlyThinkRate = (thinking 있는 텍스트 턴) / max(1, 텍스트 턴)` — §9 가드용(약한 신호).

---

## 4. 판정 로직 + 기본값

scoped 창 위에서 두 판정을 순서대로. **작업 정의가 티어마다 다른 게(strict vs loose)
핵심**이다.

```text
turns  = kept 논리 턴(최신 chatWindow개, 절단 경계 턴 제거)
scoped = sameModelWindow ? turns.filter(model === 현재모델) : turns
recent = scoped.slice(-recentK)   # recentK 기본 = chatWindow → recent = 전체 창

# 티어 1 — 작업 게이트(지배적, STRICT isWork). 창 전체에 작업 턴 하나면 이김.
if recent.some(isWork):                 conversational = false          # 작업형, 종료

# 티어 2 — 지속 대화(LOOSE hasTool). 다운그레이드가 뜨는 유일한 칸.
elif scoped.length < chatMinTurns:      conversational = false          # 근거 부족 → 넛지 안 함
else:
    toolShare = count(scoped, hasTool) / scoped.length
    if toolShare >= toolShareFloor:     conversational = false          # 도구 있음 → 대화 아님
    elif suppressOnError && struggled:  conversational = false          # 어려운 디버깅 → 모델 유지
    elif keepOnThinking &&
         textOnlyThinkRate >= thinkKeepRate: conversational = false      # §9 — 기본 OFF 권고
    else:                               conversational = true           # 진짜 대화 스트릭
```

기본값(전부 config 튜닝 가능):

| 파라미터 | 기본 | 근거 |
| --- | --- | --- |
| `recentK` | **12 (= chatWindow)** | **하중 정정(적대검증)**. 초판 `4`는 짧아 무거운 세션의 설명 스트릭에서 이전 작업 턴을 못 짚어 오발화(전 코퍼스 34건/7세션, 26건은 같은 12턴 창 안에 진짜 작업 턴이 있었음). 티어1을 **전체 창에 작업 턴 하나라도**로 넓히면 무거운 오발화 34→8·7→2세션, 잡담은 여전히 발화(11/34). `chatWindow×recentK` 스윕상 무거운 오발화를 0으로 만드는 운영점은 없음(구조적 얇은 데이터) → 창 확대가 최고 레버리지 |
| `chatWindow` | **12** | 대화 판정 창 크기. 티어1(작업 유무)·티어2(지속성)가 같은 창을 쓴다 |
| `toolShareFloor` | **0.40** | **주의: 하중 신호 아님**. 세션 전체 toolShare는 잡담 0.22 vs 나머지 27세션 ≥0.57로 갈리지만, 이건 **세션 통계**라 훅이 쓰는 12턴 창에선 무너진다(발화 시점 창 toolShare 0.083~0.333, 잡담 창 0.09와 겹침). 실 분리자는 티어1 게이트. 이 문턱은 2차 약한 필터(튜닝은 second-order) |
| `chatMinTurns` | **8** | 컴팩션·세션 초반 꼬리는 짧게 시작 → 8턴 미만이면 다운그레이드 거부(→ 적합). 단, 장문 잡담 256KB 꼬리도 자주 8턴 미만이라 발화가 산발적임(§8 잔여한계) |
| `sameModelWindow` | **true** | mixed-model 창 수정: 방금 전환한 Opus에 이전 Fable 스트릭의 대화성을 씌우지 않음. 전환 직후 짧으면 underrun → 적합(안전 방향) |
| `suppressOnError` / `repeatEditN` | **true / 3** | 오류·수정루프와 싸우는 중엔 넛지 억제(설명 많은 하드 디버깅에서 toolShare가 문턱 아래로 내려가는 구간). **억제 방향만**. `repeatEditN=3`은 #22 fix-loop 마커 |
| `keepOnThinking` / `thinkKeepRate` | **false / 0.6** | §9 참조 — verify 발견으로 **기본 OFF**. 옵트인 노브로만 유지 |
| `expensive` / `target` | `["fable","opus"]` / `"sonnet"` | 기존 config 재사용 |

**실측(전 코퍼스, 확대 게이트 적용)**: 무거운 엔지니어링 세션은 12턴 창에 편집/엔지Bash
턴이 하나라도 있으면 → 티어1 → 작업형. 잔여 무거운 발화 8건은 **작업 턴이 창에 전무한 순수
설명 창**(= §8-d 케이스). 진짜 잡담 `f0cf3e00`는 작업 턴 전무·toolShare 0.09 → 대화형 →
발화(꼬리 길이 탓 산발적 42%, §8).

---

## 5. 결과 매핑

**§9 결정에 따라 `downgrade`는 상시 false로 억제**한다(비구현 버킷 넛지 미발화). 그러면 항상
`모델 적합(<mode>)`만 뜬다. 아래 매핑은 넛지를 되살릴 경우(다른 사용 패턴·옵트인)의 참조 형태로
남긴다 — `test/model-fit-gate.test.mjs` 경계2가 이 억제를 회귀로 지킨다.

```text
isExpensive = expensive.some(e => (model ?? "").includes(e))    # bare id, [1m] 접미사 없음
pt = priceForAlias(target); pm = priceForAlias(model)
cheaperOk = (pt && pm) ? pt.output < pm.output : isExpensive     # 극성 가드

mode      = conversational ? "대화형" : "작업형"
downgrade = false   # §9: 억제. (넛지 되살릴 경우: conversational && isExpensive && cheaperOk)

text = downgrade
     ? `⚠ /model ${target} 권장(${mode} ${scoped.length}중 ${textOnlyN})`
     : `모델 적합(${mode})`
```

`priceForAlias`는 풀 id와 bare 별칭을 둘 다 해석해 가드를 실효화한다(별칭 `"sonnet"`을
`priceFor`가 null로 떨구는 버그 회피):

```js
const priceForAlias = (a) => priceFor(a) ?? (PRICES.find(([k]) => k.includes(a))?.[1] ?? null);
```

`priceForAlias("sonnet")` → `{input:3,output:15}`; `priceForAlias("claude-opus-4-8")` →
`{input:5,output:25}` → `15 < 25` → 다운그레이드 허용. 오설정 `target:"fable"`(output 50)
→ `50 < 25` 거짓 → **넛지 없음**. 싼 모델은 `isExpensive` 불성립 → 항상 적합. 업그레이드는
구조적으로 불가. text 형태는 현행과 바이트 동일(`대화형 N중 M`)이라 `sanitize()`·statusline
통과 무변경.

---

## 6. 훅 / statusline 분리

- **Stop 훅(`model-advisor.mjs`) — 모든 작업**: `readTail` → `analyzeTurns`(id 그룹화·분류·
  `struggled`·절단 안전 창) → same-model scope → 2티어 → `priceForAlias` 가드 → verdict 한
  문자열 조립·`sanitize` → `saveAdvice(transcriptPath, {text, model, ts})`. 근거가 전무할
  때만(`model===null`/0턴) `null` 저장(세그먼트 클리어). **절대 `exit 2` 없음**.
- **statusline(`statusline.mjs`) — 무변경, 핫패스 무I/O**: 작은 상태파일 재읽기 + 기존
  3중 검사(존재·신선·`normModelId` 자기소거). 트랜스크립트 파싱·config 로드 없음.

---

## 7. 설정 표면

`lib/config.mjs` `DEFAULTS.advisor`에 §4 파라미터 추가. 얕은 `Object.assign`이 이미
병합. 하위호환: 레거시 `window`/`threshold`는 수용하되 대체됨 — 한 줄로 기존 `window`가
새 창을 튜닝하게:

```js
if (user.advisor?.window != null && user.advisor?.chatWindow == null)
  merged.advisor.chatWindow = user.advisor.window;   // threshold는 이제 무효
```

---

## 8. 고쳐지는 실패모드 + 잔여 한계

| 고침 | 방법 |
| --- | --- |
| 블록 쪼개짐(근본; 2.12배 인플레·죽은 `tool_use≤1`) | S0 id 그룹화 — 텍스트 조각 지배·장문 인플레도 흡수 |
| Bash/Read/Grep 사각지대 | `isWork`에 엔지니어링 Bash 편입; `toolShare`는 조회도 `hasTool`로 셈 |
| 버스트 스크롤아웃·문턱대 불안정 | 티어 1 작업 게이트(전체 창에 작업 1회면 작업형) → 구조적 히스테리시스 |
| 창 underrun 침묵·컴팩션 손실 | `chatMinTurns` → underrun은 작업형/적합으로(숨은 플래그 아님) |
| mixed-model 창 | `sameModelWindow`로 현재 모델 턴만 |
| null-model·`[1m]` 엣지 | null → 비싸지 않음 → 적합; statusline `normModelId`가 `[1m]` 제거 |

잔여 한계(정직하게):

- **진짜 단순질문을 놓친다.** §9 결정으로 비구현 버킷은 넛지를 안 띄우므로, 드물게 존재할
  "비싼 모델로 순수 단순 Q&A" 스트릭도 다운그레이드 권고를 못 받는다. 게이트 실측상 이
  유저 코퍼스엔 그런 케이스가 사실상 없어(단순질문 합의 0건) 손실은 거의 0이고, 쫓을 판별
  신호도 트랜스크립트에 없다.
- **다운그레이드 기능의 실효 가치가 이 유저에겐 ~0.** 구현 아닐 때는 설계(강한 모델이 값함)
  라 넛지 기회가 없다 → model-advisor는 실질적으로 작업 모드 표시(`적합(작업형/대화형)`)로
  동작한다. 게이트가 이 상태를 회귀로 고정한다.
- **비싼 모델로 긴 읽기 전용 조사**(`rg`/`cat`/Read 다수, 편집 없음)는 작업형(`hasTool`)으로
  분류 — 어차피 넛지는 억제라 무영향.
- **한 턴 지연**(DESIGN §8-f) 불변: verdict는 마지막 Stop 기준.
- **읽기 전용 `git`/`gh`가 작업으로 분류**되는 비대칭(§3) — 표시 라벨에만 영향, 넛지 무영향.

---

## 9. 결정(확정) — 비구현 넛지 억제 (§8-d, 게이트로 종결)

원 설계는 "비싼 모델로 깊은 설계 토론 중"(DESIGN §8-d 오탐)을 막으려 thinking 블록
**존재율**로 다운그레이드를 억제하는 `keepOnThinking` 가드를 기본 ON으로 뒀다. **적대
검증이 이를 기각했다**:

- **블로커**: 이 유저는 thinking을 사실상 항상 켜서 존재율이 모든 세션 73~91%. 가드
  기본 ON이면 **모든 세션에서 다운그레이드가 0% 발화** → 기능이 무력(항상 "적합"). 정작
  잡을 잡담 세션(`f0cf3e00`, 존재율 91%)도 억제됨.
- **판별 불가**: thinking 존재율은 무거운 엔지니어링(73~85%)과 잡담(91%)을 **못 가른다** —
  오히려 잡담이 근소하게 더 높다(라벨된 "깊은 추론 전용" 세션은 코퍼스에 없음). 가르는
  신호(thinking **본문 길이**)는 트랜스크립트에서 본문이 삭제돼(39/39·365/365 빈 문자열)
  못 쓴다. `message.usage.output_tokens`는 전 줄(1166/1166) 존재하지만 이 유저는 어디서나
  extended thinking을 켜서 **비판별적**(잡담 중앙값이 오히려 최고, ~4059)이라 대체 신호가
  못 된다.

→ **필수: `keepOnThinking` 기본 OFF.** OFF면 검증 수치대로 작동(잡담 42% Stop 발화 — §8의
산발성 한계와 함께 읽을 것 / 무거운 세션은 확대 게이트로 8건까지 감소).

**결정(확정): 비구현 버킷에 다운그레이드를 아예 발화하지 않는다.** 초판은 "설계 넛지 수용"
이었으나, **Red-Green 게이트**([`../gate/`](../gate/), 35개 실 윈도우 3인 라벨)가 더 센 결론을
실증했다: 정답 기준에서 다운그레이드 대상("대화형") 버킷은 **20 설계 : 0 단순질문**이다. 즉 그
넛지는 강한 모델이 값하는 경우에 **~95% 잘못 뜨고, 잡을 진짜 단순질문은 ~0개**다(105개 라벨
판정 중 "단순질문" 1건·합의 0건 → 단순질문 vs 설계는 트랜스크립트에서 **판별 불가**,
`separable=no`, Fleiss κ=0.926).

- 따라서 비구현 버킷은 **`적합`으로 두고 다운그레이드를 발화하지 않는다**(티어2의 다운그레이드
  분기 비활성). toolShare 기반 구현 라우팅(견고, 94~100%)은 유지 — model-advisor는 사실상
  **작업 모드 표시**로 축소되고, ⚠ 넛지는 이 유저 데이터에선 거의/전혀 안 뜬다. 드물고 탐지
  불가한 진짜 단순질문은 **놓치는 걸 감수**한다(쫓을 신호가 트랜스크립트에 없으므로).
- 이 결정은 [`test/model-fit-gate.test.mjs`](../../../test/model-fit-gate.test.mjs)에 **회귀로
  못박혀 있다**: 경계2(§8-d)가 "설계 넛지 ≤1"을 강제하므로, 이후 어떤 변경이 비구현 넛지를
  되살리면 게이트가 **RED**가 된다.
- `keepOnThinking` 가드는 이제 불필요(넛지 자체가 억제됨) — 옵트인 노브로만 잔존한다.

---

## 10. 테스트 매트릭스(통과 필수)

| # | 시나리오(꼬리 형태) | 모델 | 기대 verdict |
| --- | --- | --- | --- |
| 1 | **활성 구현** — 12턴 창 어딘가에 Edit/Write 또는 `git`/`npm test`/`node` Bash | opus | `모델 적합(작업형)`(티어 1) |
| 2 | **조사 스트릭** — `rg`/`cat`/Read 다수, 편집·엔지Bash 없음 | opus | `모델 적합(작업형)`(`hasTool`로 toolShare ≥ floor) |
| 3 | **진짜 긴 잡담/기획** — ≥8턴, 창에 작업 턴 전무, toolShare 낮음 | opus | `⚠ /model sonnet 권장(대화형 12중 N)` |
| 4 | #3와 같으나 창 어딘가에 Edit 하나 | opus | `모델 적합(작업형)`(티어 1 우선) |
| 5 | **깊은 설계 토론** — 텍스트 스트릭, ≥60% thinking 블록 | fable | keepOnThinking OFF(기본): `⚠ 권장`(§8-d 수용) / ON: `모델 적합(작업형)` |
| 6 | **하드 디버깅** — 텍스트 많음, 작업 턴 전무, ≥1 is_error 또는 파일 3회+ 편집 | opus | `모델 적합(작업형)`(`struggled` veto) |
| 7 | 잡담 스트릭(#3) | **sonnet** | `모델 적합(대화형)`(안 비쌈) |
| 8 | 잡담 스트릭(#3) | **haiku** | `모델 적합(대화형)` |
| 9 | **컴팩션/세션 초반** — 꼬리에 논리턴 8개 미만 | opus | `모델 적합(작업형)`(underrun; 거짓 침묵·거짓 넛지 둘 다 없음) |
| 10 | **빈 꼬리 / 전부 `<synthetic>`** | — | 세그먼트 없음(`saveAdvice(null)`) |
| 11 | 블록 쪼개진 작업 턴(thinking→(tool_result 끼임)→text→Edit) | opus | **작업 턴 1개**로 집계(assistant-필터 후 id 그룹화) |
| 12 | **mixed-model** — Fable→Opus 전환 걸친 창, 최근 Opus는 잡담·이전 Fable은 무거움 | opus | Opus scope만 판정(`sameModelWindow`); scope<8 → `적합(작업형)` |
| 13 | **오설정** `target:"fable"`, opus로 잡담 | opus | `모델 적합(대화형)` — 업그레이드 미발화(`cheaperOk` 거짓) |
| 14 | `/model sonnet` 직후(라이브 id sonnet, stale advice는 opus) | — | statusline `normModelId` 자기소거(무변경) |

**e2e 회귀(적대검증 요구)**: 실 잡담 꼬리(`f0cf3e00`)에 **전체 파이프라인**(tail+2티어+가드)을
돌려 다운그레이드가 실제로 발화하는지, 무거운 실 꼬리에선 발화 안 하는지 단언. 초판 검증이
whole-session 슬라이딩 윈도 스크립트로 실제 파이프라인을 우회해 무력화·오발화 결함을 둘 다
놓쳤던 전례 방지.

모든 잔여 오분류는 **넛지 억제 방향**(거짓 작업형/적합)에 떨어져 플러그인 보수 원칙
(DESIGN §5)을 지킨다.

---

## 11. 구현 포인터

수정 파일: `core/model-guard/lib/transcript.mjs`, `core/model-guard/model-advisor.mjs`,
`core/model-guard/lib/config.mjs`. **statusline·상태파일 형태 무변경**.

의존성 경로(실측 확인):

- `bashPattern`: `lib/patterns.mjs`(repo 루트). transcript.mjs에서 `../../../lib/patterns.mjs`.
- `priceFor`·`PRICES`: `lib/pricing.mjs`(repo 루트). model-advisor.mjs에서 `../../lib/pricing.mjs`.
  `PRICES` 엔트리 = `[id, {input, output}]`; `priceFor`는 `startsWith` 매칭.

구현 위험(적대검증 지적):

- **`struggled`/`anyError`는 USER 엔트리 전용 스캔**이어야 한다. `is_error`는 assistant
  엔트리엔 0건, user `tool_result`에만 있다(예: `6f34b83c`에서 user 32건). assistant-only
  `perTurn` 구조에서 파생하려 하면 veto가 조용히 죽어 하드 디버깅 중 거짓 넛지가 난다 —
  창 바이트 구간의 user 엔트리를 **별도로 훑어** 수집할 것.
- **S0 그룹화는 assistant-필터 스트림 위에서**(§3) — raw 줄 기준으로 같은 id를 이어붙이면
  중간 user `tool_result` 때문에 턴이 파편화된다.

전체 의사코드(`analyzeTurns` 재작성 + `model-advisor.mjs` 판정 블록)와 14케이스 픽스처는
워크플로우 산출물에 있다.

---

## 12. 검증 근거

**조사·설계 워크플로우**(에이전트 12, 무오류): 실증 채굴 + 모델 선택 베스트프랙티스 + 현행
실패 분석 + 제약/신호 카탈로그 → 후보 3안(미니멀-견고 33 / 신호-가중 30 / 2티어 34) 심사 →
2티어 베이스 + 접목 종합 → 단일 적대 검증.

**독립 적대검증 패널**(에이전트 5, 2026-07-10, 판정 = **needs-revision → 정정 반영**): 실
트랜스크립트에 전체 파이프라인을 매 Stop 재현. 확인·정정된 핵심:

- 블록 쪼개짐 2.12배 인플레·`tool_use≤1` 죽은 코드 실측 재확인.
- **헤드라인 반증**: 초판의 "무거운 세션 4개 → 100% 작업형"은 조용한 세션 4개(0~2%)만
  고른 것. 전 코퍼스 36개 고비용 세션 중 **8개 발화**(무거운 7개, 최대 32%) — 작업 중 거짓
  넛지 재발. **정정: 티어1 게이트 전체 창(12) 확대 → 무거운 오발화 34→8·7→2세션**(잡담은
  여전히 발화).
- `toolShare 0.22 vs ≥0.57`은 **세션 통계**이지 12턴 창의 분리자가 아님(창 값 0.083~0.333이
  잡담 0.09와 겹침). 실 분리자는 티어1 게이트.
- §9 근거 교정: "깊은 추론 83%"는 실재 없는 라벨의 조작 수치였고, "신호가 삭제됨"은 부정확
  (본문만 삭제, `output_tokens`는 존재하나 비판별적). **결론(keepOnThinking 기본 OFF)은 유지.**
- 구현 위험 2건(struggled는 user 엔트리 스캔 / S0는 assistant-필터) 반영(§11).
