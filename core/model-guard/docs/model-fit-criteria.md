# Model-Advisor 판정 기준 재설계 — 2티어 최근성 + 가드 (설계)

> **상태**: 제안(설계). 구현 대기. 확정 시 [`../DESIGN.md`](../DESIGN.md) §4.3의 판정
> 로직을 대체한다. statusline·상태파일 형태·자기소거(§4.5)는 **무변경**.
> **근거**: 실 트랜스크립트 대상 조사·설계·적대검증 워크플로우(에이전트 12, 2026-07-08).

---

## 0. 요약

model-advisor가 "현재 모델이 이 작업에 과한가"를 판정하는 기준을, 현행 "최근 8개
assistant 엔트리 중 light 6개" 휴리스틱에서 **논리 턴 기반 2티어 판정**으로 바꾼다.
현행 기준은 실측으로 두 군데가 깨져 있었다(§1). 새 기준은 실 트랜스크립트에서 무거운
엔지니어링 세션을 **100% 작업형**으로 잡는다(현행은 68~79% 오분류). 미결 결정 하나가
남아 있다(§9, `keepOnThinking`).

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

1. **논리 턴 복원**: 연속된 같은 `message.id` 엔트리를 한 턴으로 묶는다(인플레 해소).
   `isSidechain`·`<synthetic>` 제외.
2. **턴 분류**: 각 논리 턴을 작업 턴 / 텍스트 턴 / (조회 도구만 쓴) 중립 턴으로.
3. **2티어 판정**:
   - **티어 1 — 최근성 게이트(지배적)**: 최근 `recentK`턴 중 **작업 턴이 하나라도**
     있으면 → 작업형. 즉시 확정.
   - **티어 2 — 지속 대화**: 최근 작업이 없을 때만. 턴 수·툴 비율 문턱을 넘으면 대화형
     → 다운그레이드. 이 칸만 권고를 낸다.

---

## 3. 신호 정의 — 트랜스크립트 꼬리에서 계산

전부 `readTail(path, 262144)`(파일 끝 ~256KB seek-read)에서 나온다. 검증된 필드:
assistant 엔트리 `type==="assistant"` / `message.role==="assistant"`; `message.id`;
`message.model`; `message.content[]`(블록 `.type ∈ {text, thinking, tool_use}`, tool
블록에 `.name`·`.input.command`·`.input.file_path`). tool 결과는 **user** 엔트리의
`content[].type==="tool_result"`(`.is_error` 선택)로 온다.

**S0 — 논리 턴 그룹화(핵심 활성화 요소).** 연속된 같은 `message.id` 엔트리를 한 논리
턴으로 합친다. 같은 id 줄은 연속임이 실측됐다 → 꼬리 계산에 안전. `id` 없으면 그 엔트리
자체가 한 턴(fail-open; 실측 0%).

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

**S5 — 창 수준 파생 신호**(scoped 창 위에서):

- `toolShare = count(hasTool) / kept.length` — 가장 강한 단일 분리 신호.
- `struggled = anyError || repeatEdit` — `anyError`는 창 구간의 user
  `tool_result.is_error===true` 존재, `repeatEdit`는 한 `file_path`가 `repeatEditN`회
  이상 Edit/Write/MultiEdit.
- `textOnlyThinkRate = (thinking 있는 텍스트 턴) / max(1, 텍스트 턴)` — §9 가드용(약한 신호).

---

## 4. 판정 로직 + 기본값

scoped 창 위에서 두 판정을 순서대로. **작업 정의가 티어마다 다른 게(strict vs loose)
핵심**이다.

```text
turns  = kept 논리 턴(최신 chatWindow개, 절단 경계 턴 제거)
scoped = sameModelWindow ? turns.filter(model === 현재모델) : turns
recent = scoped.slice(-recentK)

# 티어 1 — 최근성 게이트(지배적, STRICT isWork). 최근 작업 턴 하나면 이김.
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
| `recentK` | **4** | 최근 4턴 슬라이스는 구현 중이면 거의 항상 작업 턴 ≥1 포함. 티어 1은 **하나**면 충분(옛 "8중 6" 대비 훨씬 견고) → 버스트 스크롤아웃 제거 |
| `chatWindow` | **12** | `recentK`보다 길어 대화 판정엔 *지속성* 요구. 최근성이 즉시성, 창은 스트릭 확인 |
| `toolShareFloor` | **0.40** | 실측상 가장 깨끗한 분리선: 진짜 잡담 세션 = **0.22**, 나머지 27개 세션 전부 **≥ 0.57**. 0.40이 양쪽 ~0.18 마진 중앙. `hasTool` 기준(조회 Read도 대화에서 제외 — 보수적) |
| `chatMinTurns` | **8** | 컴팩션·세션 초반 꼬리는 짧게 시작 → 8턴 미만이면 다운그레이드 거부(→ 적합). toolShare 분모도 의미 있게 유지 |
| `sameModelWindow` | **true** | mixed-model 창 수정: 방금 전환한 Opus에 이전 Fable 스트릭의 대화성을 씌우지 않음. 전환 직후 짧으면 underrun → 적합(안전 방향) |
| `suppressOnError` / `repeatEditN` | **true / 3** | 오류·수정루프와 싸우는 중엔 넛지 억제(설명 많은 하드 디버깅에서 toolShare가 문턱 아래로 내려가는 구간). **억제 방향만** → 진짜 잡담엔 무영향. `repeatEditN=3`은 #22 fix-loop 마커 |
| `keepOnThinking` / `thinkKeepRate` | **false / 0.6** | §9 참조 — verify 발견으로 **기본 OFF**. 옵트인 노브로만 유지 |
| `expensive` / `target` | `["fable","opus"]` / `"sonnet"` | 기존 config 재사용 |

**실측 워크드 체크**: 무거운 `d6ed1003` → 최근 4턴에 편집/엔지니어링 Bash → 티어 1 →
작업형(현행은 79% 창에서 오탐). 진짜 잡담 `f0cf3e00` → 최근 작업 없음, 12턴,
`toolShare 0.22 < 0.40`, 오류 없음 → 대화형 → 정상 발화.

---

## 5. 결과 매핑 — 다운그레이드 전용

```text
isExpensive = expensive.some(e => (model ?? "").includes(e))    # bare id, [1m] 접미사 없음
pt = priceForAlias(target); pm = priceForAlias(model)
cheaperOk = (pt && pm) ? pt.output < pm.output : isExpensive     # 극성 가드

mode      = conversational ? "대화형" : "작업형"
downgrade = conversational && isExpensive && cheaperOk

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
| 버스트 스크롤아웃·문턱대 불안정 | 티어 1 최근성 게이트(1회면 K턴 유지) → 구조적 히스테리시스 |
| 창 underrun 침묵·컴팩션 손실 | `chatMinTurns` → underrun은 작업형/적합으로(숨은 플래그 아님) |
| mixed-model 창 | `sameModelWindow`로 현재 모델 턴만 |
| null-model·`[1m]` 엣지 | null → 비싸지 않음 → 적합; statusline `normModelId`가 `[1m]` 제거 |

잔여 한계(정직하게):

- **비싼 모델로 순수 텍스트 긴 설계 토론**은 다운그레이드 넛지를 받는다(§9). 이상적
  판별 신호(thinking 깊이)가 트랜스크립트에서 삭제돼 결정적 차단 불가.
- **비싼 모델로 긴 읽기 전용 조사**(`rg`/`cat`/Read 다수, 편집 없음)는 작업형(`hasTool`)
  → 넛지 없음. 의도적 보수(과발화 시 유저가 기능을 꺼버림, DESIGN §5).
- **한 턴 지연**(DESIGN §8-f) 불변: verdict는 마지막 Stop 기준.
- `toolShareFloor`는 단일 잡담 세션(`f0cf3e00`)으로 검증 — 0.22 vs ≥0.57 간극은 넓지만
  잡담 쪽 N=1. 마진(0.40 ± 0.18)이 안전 버퍼.

---

## 9. 미결 결정 — `keepOnThinking`(§8-d 트레이드오프)

원 설계는 "비싼 모델로 깊은 설계 토론 중"(DESIGN §8-d 오탐)을 막으려 thinking 블록
**존재율**로 다운그레이드를 억제하는 `keepOnThinking` 가드를 기본 ON으로 뒀다. **적대
검증이 이를 기각했다**:

- **블로커**: 이 유저는 thinking을 사실상 항상 켜서 존재율이 모든 세션 73~91%. 가드
  기본 ON이면 **모든 세션에서 다운그레이드가 0% 발화** → 기능이 무력(항상 "적합"). 정작
  잡을 잡담 세션(`f0cf3e00`, 존재율 91%)도 억제됨.
- **판별 불가**: thinking 존재율은 깊은 추론(83%)과 잡담(91%)을 못 가른다 — 오히려 잡담이
  더 높다. 가르는 신호(thinking **본문 길이**)는 트랜스크립트에서 삭제됨(0/863 비어있음).

→ **필수: `keepOnThinking` 기본 OFF.** OFF면 검증 수치대로 정상 작동(잡담 42% / 설계토론
6~9% / 무거운 세션 0% 발화).

**남는 트레이드오프(제품 결정)**: OFF면 순수 텍스트 설계 토론 스트릭이 넛지를 받는다.

- **권고: 수용**(문서 저자 판단). (1) 결정적 판별 신호가 없고, (2) 순수 텍스트 설계 토론은
  실제로 sonnet으로 충분한 경우가 많아 "틀린 넛지"라 단정 어렵고, (3) 강제 아닌 상시
  세그먼트 한 줄이라 무시 비용이 0에 가깝다. `keepOnThinking`은 옵트인 노브로만 유지
  (extended-thinking을 안 쓰는 유저가 §8-d 보호를 원하면 켤 수 있게).

이 결정이 확정돼야 구현 착수한다.

---

## 10. 테스트 매트릭스(통과 필수)

| # | 시나리오(꼬리 형태) | 모델 | 기대 verdict |
| --- | --- | --- | --- |
| 1 | **활성 구현** — 최근 4논리턴에 Edit/Write 또는 `git`/`npm test`/`node` Bash | opus | `모델 적합(작업형)`(티어 1) |
| 2 | **조사 스트릭** — `rg`/`cat`/Read 다수, 편집·엔지Bash 없음 | opus | `모델 적합(작업형)`(`hasTool`로 toolShare ≥ floor) |
| 3 | **진짜 긴 잡담/기획** — ≥8턴, ~78% 텍스트, toolShare ≈ 0.22 | opus | `⚠ /model sonnet 권장(대화형 12중 N)` |
| 4 | #3와 같으나 최근 4턴에 Edit 하나 | opus | `모델 적합(작업형)`(티어 1 우선) |
| 5 | **깊은 설계 토론** — 텍스트 스트릭, ≥60% thinking 블록 | fable | keepOnThinking OFF(기본): `⚠ 권장` / ON: `모델 적합(작업형)` |
| 6 | **하드 디버깅** — 텍스트 많음, toolShare<0.40, ≥1 is_error 또는 파일 3회+ 편집 | opus | `모델 적합(작업형)`(`struggled` veto) |
| 7 | 잡담 스트릭(#3) | **sonnet** | `모델 적합(대화형)`(안 비쌈) |
| 8 | 잡담 스트릭(#3) | **haiku** | `모델 적합(대화형)` |
| 9 | **컴팩션/세션 초반** — 꼬리에 논리턴 8개 미만 | opus | `모델 적합(작업형)`(underrun; 거짓 침묵·거짓 넛지 둘 다 없음) |
| 10 | **빈 꼬리 / 전부 `<synthetic>`** | — | 세그먼트 없음(`saveAdvice(null)`) |
| 11 | 블록 쪼개진 작업 턴(thinking→text→Edit 3줄) | opus | **작업 턴 1개**로 집계(light 2 + heavy 1 아님) |
| 12 | **mixed-model** — Fable→Opus 전환 걸친 창, 최근 Opus는 잡담·이전 Fable은 무거움 | opus | Opus scope만 판정(`sameModelWindow`); scope<8 → `적합(작업형)` |
| 13 | **오설정** `target:"fable"`, opus로 잡담 | opus | `모델 적합(대화형)` — 업그레이드 미발화(`cheaperOk` 거짓) |
| 14 | `/model sonnet` 직후(라이브 id sonnet, stale advice는 opus) | — | statusline `normModelId` 자기소거(무변경) |

모든 잔여 오분류는 **넛지 억제 방향**(거짓 작업형/적합)에 떨어져 플러그인 보수 원칙
(DESIGN §5)을 지킨다 — 유저 원 버그(작업 중 거짓 넛지)는 티어 1 + 엔지Bash + `struggled`로
구조적으로 제거된다.

---

## 11. 구현 포인터

수정 파일: `core/model-guard/lib/transcript.mjs`, `core/model-guard/model-advisor.mjs`,
`core/model-guard/lib/config.mjs`. **statusline·상태파일 형태 무변경**.

의존성 경로(실측 확인):

- `bashPattern`: `lib/patterns.mjs`(repo 루트). transcript.mjs에서 `../../../lib/patterns.mjs`.
- `priceFor`·`PRICES`: `lib/pricing.mjs`(repo 루트). model-advisor.mjs에서 `../../lib/pricing.mjs`.
  `PRICES` 엔트리 = `[id, {input, output}]`; `priceFor`는 `startsWith` 매칭.

전체 의사코드(`analyzeTurns` 재작성 + `model-advisor.mjs` 판정 블록)와 14케이스 픽스처는
워크플로우 산출물에 있다. 검증이 요구한 회귀 테스트: 실 잡담 꼬리에 **전체 파이프라인**
(tail+2티어+가드)을 돌려 다운그레이드가 실제로 발화하는지 단언(초기 검증이 슬라이딩
윈도 스크립트로 keepOnThinking veto를 우회해 무력화 결함을 놓쳤던 전례 방지).

---

## 12. 검증 근거

조사 워크플로우(에이전트 12, 무오류): 실증 채굴 + 모델 선택 베스트프랙티스 + 현행 실패
분석 + 제약/신호 카탈로그 → 후보 3안(미니멀-견고 33 / 신호-가중 30 / 2티어 34) 심사 →
2티어 베이스 + 접목 종합 → 실데이터 적대 검증. 핵심 수치:

- 블록 쪼개짐 2.12배 인플레·`tool_use≤1` 죽은 코드 실측 재확인.
- 무거운 엔지니어링 세션 4개 → 새 기준 100% 작업형(현행 68~79% 오탐).
- `toolShare` 분리: 잡담 0.22 vs 나머지 27개 세션 ≥ 0.57.
- verify가 `keepOnThinking` 기본 ON의 무력화 결함을 잡아 기본 OFF로 정정(§9).
