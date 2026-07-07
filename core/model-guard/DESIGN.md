# Model Guard — 설계 문서 (v2)

> 토큰 예산 보호의 **모델 축**. 두 개의 얇은 훅으로 구성된다:
> ① 서브에이전트 스폰의 모델을 **강제 다운그레이드**하고(subagent-guard),
> ② 메인 세션이 고비용 모델을 **헛돌리고 있으면 statusline에 상시 표시**한다(model-advisor).

agent-context-protector 플러그인의 한 모듈(`core/model-guard/`). 모듈 컨트랙트는
[`AGENTS.md`](../../AGENTS.md), 공유 헬퍼는 [`lib/hook-io.mjs`](../../lib/hook-io.mjs),
플러그인 전체 전략은 [루트 DESIGN.md](../../DESIGN.md). 문서 관례(한국어 번호 절,
설정 `<project>/.claude/*.json`, 상태 `os.tmpdir()`)는 claude-hooks의
`core/gate`·`core/context` DESIGN.md를 따른다.

---

## 0. v2 변경 요약 (2026-07 — v1 대비)

1. **§9 실측 6항목 완료** (2026-07-04, CC 2.1.197 — 원본은 [이슈 #6 코멘트]).
   결과가 설계를 갈랐다: subagent-guard는 커버리지 한계가 확정됐고(§2),
   model-advisor는 구현 가능이 확정됐다.
2. **model-advisor 출력 채널 재설계**: Stop `systemMessage` 1회 → **statusline
   상시 세그먼트** (§4). 근거는 /compact 상시 권고(PR #23, 머지됨)와 동일 —
   "모델이 과한가"는 순간 이벤트가 아니라 지속 상태이므로 지속 표시 표면이 맞다.
   추가로 statusline만 가능한 **자기 소거**(§4.5)를 얻는다.
3. **쿨다운 ledger(구 §6) 폐기** — 상시 표시는 수동적이라 "잔소리 상한"이
   필요 없다. 매 Stop 재평가가 표시·소거를 모두 담당한다.
4. **subagent-guard는 설계 유지, 도입 판단 보류** (§3) — 훅(선택적, 그러나
   Workflow·Fable 사각지대) vs env(전체 커버, 그러나 무차별)의 양자택일이
   실측으로 확정됐고, 아직 결정하지 않았다.

[이슈 #6 코멘트]: https://github.com/ollybaysion/agent-context-protector-plugin/issues/6

---

## 1. 핵심 아이디어 — 권한 비대칭이 설계를 결정한다

토큰 과소비는 두 꼭지에서 난다: **스폰되는 서브에이전트**(워크플로우 포함 — 실측
사례: 설계 워크플로우 1회 ~40만, 문서 스캔 1회 ~20만 토큰)와 **메인 세션 자체**
(대화형 Q&A에 Fable/Opus를 계속 쓰는 경우).

그런데 훅이 가진 권한이 두 꼭지에서 다르다:

| 꼭지 | 훅의 권한 | 그래서 |
| --- | --- | --- |
| 서브에이전트 스폰 | 도구 입력을 실행 전에 **재작성 가능** (`updatedInput`) | **강제한다** — 정책이 판단 |
| 메인 세션 모델 | 변경 API 없음 (`/model`은 유저 전용) | **표시만 한다** — 유저가 판단 |

이 비대칭을 그대로 두 스크립트로 옮긴 것이 이 모듈이다. 강제할 수 있는 곳은
조용히 강제하고, 강제할 수 없는 곳은 **statusline 한 세그먼트**(모델 컨텍스트
미경유 = 토큰 0)를 띄운다.

> 절약 훅의 자기모순 금지 원칙: 이 모듈은 어떤 경로에서도 **LLM을 호출하지
> 않는다**. 판정은 전부 결정적(정규식·카운트·임계값)이다.

---

## 2. 실측 결과 (구 §9 게이트, 2026-07-04 완료) — 설계를 바꾼 사실들

라이브 세션 + 헤드리스 `claude -p` 조합으로 6항목 전부 확인 (CC 2.1.197).
증거·상세는 [이슈 #6 코멘트]가 원본.

| # | 항목 | 결과 |
| --- | --- | --- |
| 1 | 스폰 tool_name | **`Agent`** (Task 아님, 히스토리 21/21 + 라이브 3세션). matcher는 `Task\|Agent`로 하위호환 |
| 2 | PreToolUse `updatedInput`으로 `model` 재작성 | **일반(Opus/Sonnet) 세션에서 작동** (opus→haiku 실증). 단 Fable 세션은 무시(아래 ⚠️) |
| 3 | Workflow 내부 `agent()` 스폰 | **PreToolUse 미발생 — 사각지대 확정.** 훅 가드는 Workflow를 원천적으로 못 본다 |
| 4 | 트랜스크립트 `message.model` | assistant 6,834/6,834 존재. `<synthetic>` ×5 → 필터 필요 |
| 5 | Stop `systemMessage` 렌더 | 통과 (v2에서는 미사용이지만 채널 자체는 검증됨) |
| 6 | `tool_input.subagent_type` | 21/21 항상 존재. `model` 키는 호출자가 넘길 때만(0/21) — "키 없음 = 세션 모델 상속" |

강제 수단 매트릭스:

| 레버 | Agent 툴 스폰 | Workflow `agent()` | 우선순위 |
| --- | :---: | :---: | --- |
| `CLAUDE_CODE_SUBAGENT_MODEL` env | ✅ (명시 `model` 파라미터도 이김) | ✅ **유일하게 커버** | 1위 |
| PreToolUse `updatedInput` | ✅ (일반 세션) | ❌ 이벤트 자체가 없음 | 2위 |
| 명시 `model` 파라미터 / `opts.model` | ✅ | ✅ | 3위 |

⚠️ **Fable-5 세션의 sonnet 핀** (Fable에서만 측정, 버전에 따라 바뀔 수 있음):
Fable 세션은 모든 서브에이전트 스폰을 sonnet으로 고정한다 — 명시 파라미터,
훅 재작성, Workflow `opts.model` 전부 무시. 하네스가 Bash 서브셸에
`CLAUDE_CODE_SUBAGENT_MODEL=sonnet`을 주입하므로 중첩 `claude -p` 실험 시
`env -u`로 벗겨야 한다.

**함의**: subagent-guard(훅)는 "일반 세션 × Agent 툴 경로"에서만 유효하다.
전체 커버가 필요하면 env 레버뿐인데, env는 예외(`exemptTypes`)가 불가능하고
훅과 양립 불가(env가 이김).

---

## 3. `subagent-guard.mjs` — PreToolUse(Task|Agent), 강제 다운그레이드 [도입 판단 보류]

> **상태**: 설계·스켈레톤 유지, 구현 착수는 §2 함의에 대한 결정 대기 —
> "제한된 커버리지(일반 세션 + Agent 경로)로도 훅을 구현할 가치가 있는가,
> env var로 갈 것인가, 둘 다 안 할 것인가."
> 주력 세션이 Fable인 동안은 핀 때문에 훅이 무력하다는 점이 판단의 핵심 변수.

```text
Agent 도구 호출 → PreToolUse → tool_input.model 검사
   ├ exemptTypes에 든 subagent_type        → pass()
   ├ model이 target 이하 (haiku 등)         → pass()   (절대 업그레이드 안 함)
   └ model이 없거나(=세션 모델 상속) 대형   → updatedInput으로 target 주입
```

```js
// core/model-guard/subagent-guard.mjs (요지)
import { readHookInput, pass, failOpen } from "../../lib/hook-io.mjs";
import { loadConfig } from "./lib/config.mjs";

// 다운그레이드 전용 정책의 심장. 모름(미등재)은 대형으로 취급해 낮춘다.
const RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 2 };
const rankOf = (m) => RANK[String(m ?? "").toLowerCase()] ?? 2;

try {
  const input = await readHookInput();
  if (!/^(Task|Agent)$/i.test(input?.tool_name ?? "")) pass();

  const cfg = loadConfig(input?.cwd);           // 없으면 내장 기본값 (zero-config)
  if (cfg.disabled) pass();

  const ti = input.tool_input ?? {};
  if (cfg.exemptTypes.includes(ti.subagent_type)) pass();
  if (rankOf(ti.model) <= rankOf(cfg.target)) pass();   // 이미 충분히 낮음

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...ti, model: cfg.target },       // 전체 입력 + model만 교체
    },
  }));
  process.exit(0);
} catch (err) {
  failOpen(`[model-guard] internal error, skipping: ${err?.message ?? err}`);
}
```

설계 결정 (v1 유지):

- **`model` 파라미터 부재 = 대형으로 간주.** 실측 §2-6: 스폰의 사실상 전부가
  model 미지정(0/21)이라 이게 주 타격 지점.
- **전체 `tool_input`을 되돌려준다** (`{ ...ti, model }`). `updatedInput`은 입력을
  통째로 교체하므로 부분 객체를 주면 다른 인자가 유실된다.
- **`denyPreToolUse`가 아니라 `updatedInput`.** 차단이 아니라 교정 — 흐름을 끊지
  않고 스폰은 그대로 진행된다. 공유 헬퍼 `rewriteToolInput(updatedInput)` 추가(§10).

---

## 4. `model-advisor` — Stop 판정 + statusline 상시 표시 (v2 재설계)

### 4.1 비용 비대칭에 따른 역할 분리

statusline은 렌더마다 실행되는 핫패스라 **무I/O 규율**(PR #19)이 있고, Stop은
턴 완결 후라 무거워도 되는 자리다(AGENTS.md 규율). 판정 비용의 99%는
트랜스크립트 파싱이므로:

| | `model-advisor.mjs` (Stop 훅) | `statusline.mjs` (핫패스) |
| --- | --- | --- |
| 하는 일 | 트랜스크립트 꼬리 파싱 + 턴 형태 분석 + config 로드 + 문턱 판정 + **완성된 결과 기록** | 이미 내려진 판정의 **유효성 검사 3개 + 표시** |
| 비용 | ~256KB tail-read, 턴당 1회 | 소형 상태파일 read 1회 추가(수십 µs) + 문자열 비교 |

statusline에는 config 로드도 두지 않는다 — expensive군·문턱 판정까지 전부
훅 쪽. statusline이 받는 것은 **미리 조립·살균된 표시 문자열**뿐이다.

### 4.2 데이터 흐름

```text
턴 완결
  └─ Stop ─→ model-advisor.mjs
       ├─ transcript tail-read (~256KB)
       ├─ 메인라인 assistant 턴만 필터 (isSidechain 제외)
       ├─ 최근 window턴 형태 분석 → 가벼운 턴 카운트
       ├─ 현재 모델 = 마지막 assistant message.model (<synthetic> 제외)
       ├─ 판정: 가벼운세션 AND 모델∈expensive
       │    ├─ 참  → advice 기록 { text, model, ts }
       │    └─ 거짓 → advice 클리어 ({})     ← 매 Stop 재평가가 클리어도 담당
       └─ tmp+rename 원자 저장 → $TMPDIR/acp/model-guard/<sha1-16>.json

렌더 (수시)
  └─ statusline.mjs
       ├─ stdin: context_window·rate_limits·model.id·transcript_path (CC 제공)
       ├─ model-guard 상태파일 read (fail-open)
       ├─ 3중 검사: advice 존재? · ts 신선? · 라이브 model.id === advice.model?
       └─ 통과 시 세그먼트 추가:
          ctx 12% · 여유(컴팩트 불필요) · 5h 41% · 7d 27% · /model sonnet 권장(8중 6턴 대화형) · …
```

### 4.3 Stop 훅 상세 (`model-advisor.mjs`)

**입력**: Stop 훅 stdin의 `transcript_path`, `session_id`, `cwd`.

**파싱** (`lib/transcript.mjs`): 파일 끝에서 ~256KB만 tail-read — 세션이 커도
상수 비용. JSONL 라인별 파싱, 깨진 라인은 개별 skip. 실측 기반 필수 필터 둘:

- **`isSidechain` 제외** — 서브에이전트 엔트리가 메인 트랜스크립트에 섞인다.
  안 거르면 서브에이전트의 툴콜이 메인 세션 턴 형태를 오염시킨다.
- **`message.model === "<synthetic>"` 제외** — §2-4 실측 (6,834건 중 5건).

**턴 형태**: assistant 턴별 ① `tool_use` 블록 수, ② 무거운 도구
(Edit/Write/Task/Agent/Workflow/NotebookEdit) 사용 여부.

**판정** (v1 휴리스틱 유지, 결정적):

```text
가벼운 턴   = 툴 호출 ≤ 1  AND  무거운 도구 없음
가벼운 세션 = 최근 window턴(기본 8) 중 가벼운 턴 ≥ threshold(기본 6)
발화 조건   = 가벼운 세션 AND 현재모델 ∈ expensive(기본 fable·opus 부분일치)
턴 부족(윈도 미달 — 세션 초반·컴팩션 직후) → 판정 불가 → advice 클리어
```

**출력 — 상태 기록만** (`lib/state.mjs`). systemMessage를 내지 않는다:

```json
{ "modelAdvice": {
    "text": "/model sonnet 권장(8중 6턴 대화형)",
    "model": "claude-fable-5",
    "ts": 1751696000000 } }
```

- 발화 조건 거짓이면 `{}` 저장(클리어).
- `text`는 훅에서 미리 살균(제어문자 제거)한 완성 문자열 — statusline은
  조립하지 않는다.
- `model`은 트랜스크립트에서 읽은 정확한 모델 ID — statusline 자기 소거의 비교 키.

**매 Stop 재평가가 핵심 메커니즘**: advice는 항상 "마지막 턴 기준 최신 판정"
이고, 무거운 작업이 재개되면 다음 Stop에서 자동 클리어. 쿨다운·세션당 1회
개념이 필요 없는 이유다.

### 4.4 상태 파일 — 별도 파일, 단일 작성자

**결정: ctx-budget 상태파일에 얹지 않고
`$TMPDIR/acp/model-guard/<sha1(transcript_path) 앞16>.json` 별도 파일.**

- 같은 파일이면 핫패스 read 1회가 절약되지만, **두 모듈(ctx-budget.mjs,
  model-advisor.mjs)이 같은 파일에 read-modify-write** 하게 된다. ctx-budget은
  자기 내부 병렬 레이스를 claim-then-emit으로 잡았는데(PR #5) 외부 작성자가
  끼면 그 보증이 깨진다. 모듈 자기완결(AGENTS.md)에도 어긋난다. 별도 파일의
  추가 비용은 소형 파일 read 1회(수십 µs) — 무시 가능.
- 키가 `transcript_path` sha1인 이유: 세션별 격리 — 같은 프로젝트의 병렬
  세션 간 혼선 없음 (ctx-budget과 동일 규약).
- 저장은 ctx-budget과 동일한 **tmp+rename 원자 쓰기** — statusline이 언제
  읽어도 찢어진 JSON을 보지 않는다.
- 작성자는 model-advisor 하나뿐 → 락 불필요. tmpdir가 비워져도 최악은
  "다음 Stop까지 세그먼트 없음" — 무해. `CLAUDE_PLUGIN_ROOT` 아래 금지(불변).

이 결정으로 **statusline의 개념이 승격**된다: "ctx-budget의 HUD"가 아니라
**플러그인 공용 HUD** — 각 모듈이 자기 상태파일에 세그먼트를 발행하고
statusline이 집계 렌더한다. 이후 '적기(경계 기반)' 표시도 같은 패턴
(ctx-budget이 경계 이유를 자기 상태파일에 기록 → statusline이 읽기)으로
합류한다.

### 4.5 `statusline.mjs` 수정 — +15줄 내외, 검사 3개 전부 자명한 비교

```js
// CONTRACT: must match statePath() in model-guard's lib/state.mjs
function readModelAdvice(transcriptPath, liveModelId) {
  try {
    const s = JSON.parse(readFileSync(advicePath(transcriptPath), "utf8"));
    const a = s?.modelAdvice;
    if (!a || typeof a.text !== "string" || a.text === "") return null; // ① 존재
    if (typeof a.ts !== "number" || Date.now() - a.ts > ADVICE_MAX_AGE_MS)
      return null;                                                      // ② 신선
    if (typeof liveModelId !== "string" || liveModelId !== a.model)
      return null;                                                      // ③ 자기 소거
    return a.text;
  } catch { return null; }  // fail-open: 파일 없음/깨짐 → 세그먼트 없음
}
```

- **③이 자기 소거**: `/model sonnet` 직후 라이브 `input.model.id`가
  `advice.model`과 어긋나 세그먼트가 **즉시** 사라진다 — systemMessage가
  구조적으로 못 하는 동작. fable→opus처럼 expensive끼리 전환해도 일단
  드롭되고 다음 Stop에서 재판정 — 보수적이고 올바르다.
- `ADVICE_MAX_AGE_MS`(기본 1h, env `ACP_MODEL_ADVICE_MAX_AGE_MS`)는
  `TOP_MAX_AGE_MS`와 같은 계열 — 유저가 자리를 비워 Stop이 오래 안 돌면
  낡은 권고를 계속 띄우지 않는다.
- 출력 살균은 이중 방어: 훅에서 text 사전 살균 + 기존 choke point
  (통합 제어문자 strip)가 최종 제거 — 다른 버전이 쓴 상태파일도 신뢰하지
  않는 기존 규율 유지.
- 구버전 CC로 stdin에 `model.id`가 없으면 ③에서 조용히 탈락 — "필드
  없으면 생략" 규율(PR #23)과 동일.

### 4.6 v1 대비 변경 요약

| 항목 | v1 (§4·§6 구판) | v2 |
| --- | --- | --- |
| 출력 채널 | Stop `systemMessage` 1회 | statusline 상시 세그먼트 |
| 쿨다운 ledger (`advisor.json`) | 필요 (세션당 1회 강제) | **삭제** — 매 Stop 재평가 + 상시 표시 |
| 트랜스크립트 model 파싱 | 판정용 | 판정 + `advice.model` 기록 (자기 소거 키) |
| 소거 | 불가 (뜨면 끝) | 모델 전환 즉시 + 무거운 턴 재개 시 다음 Stop |
| `emitSystemMessage` 의존 | 필요 | 불필요 (상태파일 기록만) |

---

## 5. 설정 표면 — `<project>/.claude/model-guard.json`

zero-config: 파일이 없으면 내장 기본값. **훅만 읽는다** — statusline은
config를 열지 않는다(핫패스 규율, §4.1).

```jsonc
{
  "disabled": false,               // true = 모듈 전체 끔
  "target": "sonnet",              // subagent-guard가 강제할 모델
  "exemptTypes": [],               // subagent-guard: 통과시킬 subagent_type
  "advisor": {
    "enabled": true,
    "window": 8,                   // 최근 N턴 관찰
    "threshold": 6,                // N중 몇 턴이 가벼우면 발화
    "expensive": ["fable", "opus"],// 고비용군 (모델 ID 부분일치)
    "target": "sonnet"             // 권고 문구에 들어갈 모델
  }
}
```

- v1의 `advisor.oncePerSession` 삭제 (§4.6).
- statusline 쪽 env는 `ACP_MODEL_ADVICE_MAX_AGE_MS` 하나(선택).
- 기본값 근거: `target: sonnet`은 유저 확정값(2026-07-04). window 8 /
  threshold 6은 보수적 시작값 — 과탐이 잦으면 유저가 기능을 꺼버리므로
  확실한 대화형 스트릭에만 발화.

---

## 6. 상태 저장

- **subagent-guard: 무상태.** 매 호출 독립 판정.
- **model-advisor: advice 파일 하나** — `$TMPDIR/acp/model-guard/<sha1-16>.json`
  (§4.4). v1의 쿨다운 ledger는 폐기.

---

## 7. 안전장치

- **fail-open 절대 규율**: 두 스크립트 모두 최상위 try/catch → `failOpen`;
  statusline은 어떤 오류든 세그먼트 생략. 트랜스크립트 파싱 실패, config
  깨짐, 상태 I/O 실패 — 전부 조용한 무동작. 절약 훅이 세션/상태바를 깨는
  것은 본말전도.
- **절대 업그레이드 안 함** (subagent-guard): `rankOf(현재) <= rankOf(target)`
  이면 무조건 통과. 미등재 모델은 대형(2) 취급 — 낮추는 방향으로만 틀린다.
- **`updatedInput`은 exit 0 + stdout JSON로만** (exit 2와 혼용 금지).
- **advisor는 차단 능력이 없다**: 어떤 경로도 exit 2 / `decision:block`을
  내지 않는다. 특히 **Stop에서 exit 2는 "계속 일해라"라는 뜻**이므로 금지.
  최악의 버그도 "이상한 세그먼트 한 조각"에 그친다.
- **업그레이드 제안 없음** (advisor): "작은 모델로 무거운 작업 중" 방향은
  범위 밖 — 이 플러그인의 책임은 예산 보호뿐. (사후 감사의 업그레이드
  신호는 analyze의 model-fit, 이슈 #22 몫.)

---

## 8. 한계 (정직하게, 크기 그대로)

- **(a) subagent-guard의 커버리지는 실측으로 확정된 한계다** (§2): Workflow
  내부 스폰은 영원히 못 보고, Fable 세션에서는 핀 때문에 무력하다. 이게
  도입 보류의 이유.
- **(b) frontmatter로 싼 모델을 고정한 에이전트를 오히려 올릴 수 있다**
  (subagent-guard): 파라미터(2위) > frontmatter(3위)라, 파라미터가 비고
  frontmatter가 haiku면 sonnet 주입이 업그레이드가 된다. `exemptTypes`로
  완화. 실피해는 "약간 더 비싼 모델" 수준.
- **(c) 트랜스크립트 JSONL은 비공식 포맷.** 구조가 바뀌면 advisor가
  침묵한다(파싱 실패 = 클리어/무동작). 기능이 조용히 죽는 것을 감수한다 —
  대신 세션은 절대 안 깨진다.
- **(d) 휴리스틱은 휴리스틱이다.** "툴 없는 긴 설계 토론"은 가벼운 턴으로
  집계되지만 Fable이 값을 하는 작업일 수 있다. 완화: 강제도 팝업도 아닌
  상시 한 세그먼트라 무시 비용이 0에 가깝다.
- **(e) statusLine 미설정 유저에게는 보이지 않는다.** settings.json
  `statusLine` 배선이 전제(HUD v0.8.0부터의 전제와 동일). README에 명시.
- **(f) 판정 지연 한 턴.** advice는 마지막 Stop 기준 — 무거운 작업을 시작한
  "이번 턴" 중에는 낡은 권고가 떠 있을 수 있다. 턴이 끝나면 클리어,
  max-age가 상한.
- **(g) 메인 모델은 끝내 유저 몫.** 훅에는 변경 수단이 없다. 이 모듈의
  상한은 "정확한 상태 표시 한 세그먼트"다.

---

## 9. 구현 전 실측 체크리스트

v1 §9의 6항목은 **완료** (§2). advisor v2 구현 전 남은 것:

- [ ] statusline stdin에 `model.id`가 실제로 오는가 (docs상 존재하나 실측
      규율 — CC 2.1.198+ 기준 확인)
- [ ] Stop 훅 stdin에 `transcript_path`가 오는가 (ctx-budget은
      PostToolUse/UserPromptSubmit에서만 실측)
- [ ] 컴팩션 직후 트랜스크립트 꼬리 형태 — window 미달로 자연 침묵하는지,
      compact_boundary 이후 턴 카운트가 맞는지

이미 해소: `message.model` 존재·`<synthetic>` 필터(§2-4), Stop 이벤트
자체(§2-5), isSidechain 함정(트랜스크립트 포맷 실증).

---

## 10. 모듈 구성 & 와이어링

```text
core/model-guard/
├── model-advisor.mjs      # Stop — 판정 + 상태 기록 (§4)          [v2 착수 대상]
├── subagent-guard.mjs     # PreToolUse(Task|Agent) — 강제 다운그레이드 (§3) [보류]
├── lib/
│   ├── config.mjs         # model-guard.json + 내장 기본값 (§5)
│   ├── transcript.mjs     # tail-read + isSidechain/<synthetic> 필터 + 턴 형태 (§4.3)
│   └── state.mjs          # advicePath + tmp+rename 저장 (§4.4)
├── DESIGN.md              # 이 문서
└── README.md              # 사용법 + statusLine 전제 + env var 양립 불가(§2) 명시
core/ctx-budget/statusline.mjs   # readModelAdvice + 세그먼트 (+CONTRACT 주석, §4.5)
```

`hooks/hooks.json`에 **Stop 엔트리 신규 추가** (현재 Stop 배선 자체가 처음):

```jsonc
"Stop": [
  { "hooks": [ { "type": "command",
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/core/model-guard/model-advisor.mjs\"",
      "timeout": 15 } ] }
]
```

subagent-guard 도입이 확정되면 PreToolUse `Task|Agent` 항목 + 공유 헬퍼
`rewriteToolInput` 추가:

```js
/** PreToolUse: rewrite the tool input before it runs (exit 0 + stdout JSON). */
export function rewriteToolInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput },
  }));
  process.exit(0);
}
```

---

## 11. 구현 순서 (advisor v2)

전제: statusline /compact 권고(PR #23)와 top-N HUD(PR #27)는 main에 머지됨 —
이 작업은 그 위에 얹는다.

- [ ] §9 잔여 실측 3항목 (statusline `model.id` / Stop `transcript_path` /
      컴팩션 꼬리)
- [ ] `feat/model-advisor-statusline` 브랜치 (main 기준 신규 — 이 워크트리의
      `feat/model-guard`는 v0.4.0 시절 base라 rebase보다 새 브랜치가 깔끔)
- [ ] `core/model-guard/lib/{config,transcript,state}.mjs` + `model-advisor.mjs`
- [ ] 합성 트랜스크립트 픽스처 테스트: 가벼운 스트릭→기록 / 무거운 세션→클리어 /
      isSidechain 오염 / `<synthetic>` 필터 / 파싱 실패 침묵 / 윈도 미달 클리어
- [ ] statusline 테스트: 3중 검사 각각의 탈락 경로 + 통과 렌더 + 살균
- [ ] `hooks/hooks.json` Stop 항목 + 최상위 README Modules 표 + 루트 DESIGN.md
      모듈 행
- [ ] 라이브 검증: 대화형 스트릭 후 세그먼트 표시 → `/model sonnet` 즉시 소거 →
      무거운 턴 후 클리어
- [ ] 버전 범프(minor) + PR; 이슈 #6에 advisor 절반 완료 기록,
      subagent-guard 절반은 별도 결정으로 유지
