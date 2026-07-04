# Model Guard — 설계 문서 (v1)

> 토큰 예산 보호의 **모델 축**. 두 개의 얇은 훅으로 구성된다:
> ① 서브에이전트 스폰의 모델을 **강제 다운그레이드**하고(subagent-guard),
> ② 메인 세션이 고비용 모델을 **헛돌리고 있으면 한 문장 제안**한다(model-advisor).

agent-context-protector 플러그인의 한 모듈(`core/model-guard/`). 모듈 컨트랙트는
[`AGENTS.md`](../../AGENTS.md), 공유 헬퍼는 [`lib/hook-io.mjs`](../../lib/hook-io.mjs),
플러그인 전체 전략은 [루트 DESIGN.md](../../DESIGN.md). 문서 관례(한국어 번호 절,
설정 `<project>/.claude/*.json`, 상태 `os.tmpdir()`)는 claude-hooks의
`core/gate`·`core/context` DESIGN.md를 따른다.

---

## 1. 핵심 아이디어 — 권한 비대칭이 설계를 결정한다

토큰 과소비는 두 꼭지에서 난다: **스폰되는 서브에이전트**(워크플로우 포함 — 실측
사례: 설계 워크플로우 1회 ~40만, 문서 스캔 1회 ~20만 토큰)와 **메인 세션 자체**
(대화형 Q&A에 Fable/Opus를 계속 쓰는 경우).

그런데 훅이 가진 권한이 두 꼭지에서 다르다:

| 꼭지 | 훅의 권한 | 그래서 |
| --- | --- | --- |
| 서브에이전트 스폰 | 도구 입력을 실행 전에 **재작성 가능** (`updatedInput`) | **강제한다** — 정책이 판단 |
| 메인 세션 모델 | 변경 API 없음 (`/model`은 유저 전용) | **제안만 한다** — 유저가 판단 |

이 비대칭을 그대로 두 스크립트로 옮긴 것이 이 모듈이다. 강제할 수 있는 곳은
조용히 강제하고, 강제할 수 없는 곳은 **화면에 한 문장**(`systemMessage`, 모델
컨텍스트 미경유 = 토큰 0)을 띄운다.

> 절약 훅의 자기모순 금지 원칙: 이 모듈은 어떤 경로에서도 **LLM을 호출하지
> 않는다**. 판정은 전부 결정적(정규식·카운트·임계값)이다.

---

## 2. 근거 — 서브에이전트 모델 해석 순서 (공식 문서로 검증, 2026-07)

Claude Code가 서브에이전트 모델을 정하는 우선순위:

1. `CLAUDE_CODE_SUBAGENT_MODEL` 환경변수
2. **호출별 `model` 파라미터** ← subagent-guard가 조작하는 지점
3. 에이전트 정의 frontmatter `model`
4. 메인 대화 모델 상속 (기본)

### 왜 env var(1위)가 아니라 훅(2위)인가

`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` 한 줄이면 끝나지만 — **무차별**이다. 판정·적대적
검증처럼 대형 모델이 값을 하는 서브에이전트까지 전부 덮고, 프로젝트별 차등도, 예외
타입도 불가능하다. 훅은:

- **선택적**: `exemptTypes`로 판정용 에이전트만 통과 (env var는 불가능)
- **다운그레이드 전용**: haiku로 이미 낮춘 호출을 건드리지 않음 (env var는 이것도 sonnet으로 "올려"버린다)
- **프로젝트별**: `<project>/.claude/model-guard.json`으로 repo마다 다르게

단, env var가 설정돼 있으면 훅의 재작성(2위)은 무의미해진다(1위가 이김). 두 방식은
**양립 불가** — README에 명시한다.

---

## 3. `subagent-guard.mjs` — PreToolUse(Task), 강제 다운그레이드

```text
Task 도구 호출 → PreToolUse → tool_input.model 검사
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

설계 결정:

- **`model` 파라미터 부재 = 대형으로 간주.** 부재 시 세션 모델(Fable/Opus)을 상속하므로
  다운그레이드 대상이다. 이게 이 훅의 주 타격 지점 — 스폰 대부분이 model 미지정이다.
- **전체 `tool_input`을 되돌려준다** (`{ ...ti, model }`). `updatedInput`은 입력을
  통째로 교체하므로 부분 객체를 주면 다른 인자가 유실된다.
- **`denyPreToolUse`가 아니라 `updatedInput`.** 차단이 아니라 교정이다 — 흐름을 끊지
  않고 스폰은 그대로 진행된다. 공유 헬퍼에 `rewriteToolInput(updatedInput)` 하나를
  추가한다(§10) — `replaceToolOutput`(PostToolUse 짝)과 대칭.

---

## 4. `model-advisor.mjs` — Stop, "헛도는 고비용 모델" 한 문장 제안

### 신호 수집 — 트랜스크립트 꼬리 파싱

Stop 훅 입력의 `transcript_path`(JSONL)에서 두 가지를 읽는다. 파일 끝에서
~256KB만 tail-read (세션이 커도 상수 비용):

1. **현재 모델**: 마지막 assistant 메시지의 `message.model`
   (`claude-fable-*`/`claude-opus-*` = 고비용군, config `expensive`)
2. **최근 `window`턴(기본 8)의 작업 형태**: assistant 턴별
   - 툴 호출 수 (`tool_use` 블록 카운트)
   - "무거운 도구" 사용 여부 (Edit/Write/Task/Workflow — 코딩·스폰 작업의 표지)
   - 응답 텍스트 길이

### 판정 — 결정적 휴리스틱

```text
가벼운 턴  = 툴 호출 ≤ 1  AND  무거운 도구 없음
가벼운 세션 = 최근 window턴 중 가벼운 턴 ≥ threshold (기본 8중 6)
발화 조건  = 가벼운 세션 AND 현재 모델 ∈ expensive AND 쿨다운 통과
```

대화형 Q&A 스트릭인데 Fable을 쓰고 있다 — 그때만 발화한다. 반대 방향(작은 모델로
무거운 작업 → 업그레이드 제안)은 **범위 밖**: 이 플러그인의 유일한 책임은 예산
보호이고, 품질 부족은 유저가 스스로 알아챈다.

### 출력 — `emitSystemMessage` 한 문장

```js
// core/model-guard/model-advisor.mjs (요지)
import { readHookInput, emitSystemMessage, pass, failOpen } from "../../lib/hook-io.mjs";
import { loadConfig } from "./lib/config.mjs";
import { readTail, analyzeTurns } from "./lib/transcript.mjs";
import { loadLedger, saveLedger } from "./lib/ledger.mjs";

try {
  const input = await readHookInput();
  const cfg = loadConfig(input?.cwd);
  if (cfg.disabled || !cfg.advisor.enabled) pass();

  const led = loadLedger();                                   // { [sessionId]: { advisedAt } }
  if (cfg.advisor.oncePerSession && led[input.session_id]) pass();   // 잔소리 금지

  const turns = analyzeTurns(readTail(input.transcript_path), cfg.advisor.window);
  if (!turns.ok) pass();                                      // 파싱 실패/턴 부족 → 조용히
  if (!cfg.advisor.expensive.some((m) => turns.model.includes(m))) pass();

  const light = turns.perTurn.filter((t) => t.toolCalls <= 1 && !t.heavyTools).length;
  if (light < cfg.advisor.threshold) pass();

  led[input.session_id] = { advisedAt: Date.now() };
  saveLedger(led);
  emitSystemMessage(
    `💡 최근 ${cfg.advisor.window}턴 중 ${light}턴이 대화형(도구 거의 없음)이었어요 — ` +
    `이 세션엔 /model sonnet 이면 충분할 수 있어요.`
  );
} catch (err) {
  failOpen(`[model-guard/advisor] internal error, skipping: ${err?.message ?? err}`);
}
```

설계 결정:

- **`systemMessage` 채널**: 유저 화면에만 뜨고 모델 컨텍스트를 거치지 않는다 —
  제안 자체의 토큰 비용 0. `additionalContext`로 모델에게 "제안해라"라고 시키는
  변형은 기각: 토큰을 쓰고, 모델이 무시할 수 있고, 대화 흐름을 오염시킨다.
- **왜 Stop인가**: 턴이 완결된 뒤라 "이 턴의 형태"가 확정돼 있고, 무거워도 되는
  자리다(AGENTS.md 규율). UserPromptSubmit은 매턴 30s 예산을 먹고 아직 이번 턴
  형태를 모른다.
- **Stop에서 `exit 2`는 "계속 일해라"라는 뜻** — advisor는 절대 exit 2를 쓰지
  않는다. `emitSystemMessage`(exit 0 + stdout JSON) 아니면 `pass()`.

---

## 5. 설정 표면 — `<project>/.claude/model-guard.json`

zero-config: 파일이 없으면 내장 기본값으로 동작한다. 파일이 있으면 덮어쓴다.

```jsonc
{
  "disabled": false,               // true = 모듈 전체 끔
  "target": "sonnet",              // subagent-guard가 강제할 모델 (기본 sonnet)
  "exemptTypes": [],               // 통과시킬 subagent_type (예: ["code-reviewer"])
  "advisor": {
    "enabled": true,
    "window": 8,                   // 최근 N턴 관찰
    "threshold": 6,                // N중 몇 턴이 가벼우면 발화하나
    "oncePerSession": true,        // 세션당 1회만 제안
    "expensive": ["fable", "opus"] // 고비용군 (모델 ID 부분일치)
  }
}
```

기본값 근거: `target: sonnet`은 유저 확정값(2026-07-04). 대형 대비 큰 폭 절감이면서
탐색·리뷰 품질 유지 — haiku 일괄은 판정 품질 저하 위험이 있어 기본으로 삼지 않는다.
window 8 / threshold 6은 보수적 시작값 — **과탐이 잦으면 유저가 기능을 꺼버리므로**,
확실한 잡담 스트릭에만 발화한다.

---

## 6. 상태 저장

- **subagent-guard: 무상태.** 매 호출 독립 판정.
- **model-advisor: 쿨다운 ledger** — `os.tmpdir()/model-guard/advisor.json`,
  `{ [sessionId]: { advisedAt } }`. 세션 키라 프로젝트 해시 불필요. 오래된 세션
  엔트리는 저장 시 상한(최근 50개)으로 정리. tmpdir가 비워져도 최악은 "한 번 더
  제안" — 무해. `CLAUDE_PLUGIN_ROOT` 아래 금지(업데이트마다 바뀜).

---

## 7. 안전장치

- **fail-open 규율**: 두 스크립트 모두 최상위 try/catch → `failOpen`. 트랜스크립트
  파싱 실패, config 깨짐, ledger I/O 실패 — 전부 조용한 무동작. 절약 훅이 세션을
  깨는 것은 본말전도.
- **절대 업그레이드 안 함**: `rankOf(현재) <= rankOf(target)`이면 무조건 통과.
  미등재 모델 ID는 대형(2)으로 취급 — 낮추는 방향으로만 틀린다.
- **`updatedInput`은 exit 0 + stdout JSON로만** (exit 2와 혼용 금지 — stdout 폐기됨).
- **advisor는 차단 능력이 없다**: 어떤 경로도 exit 2 / `decision:block`을 내지
  않는다. 최악의 버그도 "이상한 한 문장"에 그친다.
- **잔소리 상한**: 세션당 1회(기본). 제안을 무시하는 것도 유저의 결정이다.

---

## 8. 한계 (정직하게, 크기 그대로)

- **(a) Workflow 내부 스폰이 PreToolUse를 타는지 미확인.** Workflow 도구 호출
  자체는 훅을 타지만, 스크립트 내부의 `agent()` 스폰은 별도 런타임 경로일 수 있다.
  §9 실측 1순위. 사각지대로 판명되면: 워크플로우는 스크립트 작성 정책(기계적 단계에
  `model`/`effort` 명시)과 병행하고, 한계를 README에 명시한다.
- **(b) frontmatter로 싼 모델을 고정한 에이전트를 오히려 올릴 수 있다.** 호출
  파라미터(2위) > frontmatter(3위)이므로, 파라미터가 비어 있고 frontmatter가
  haiku인 에이전트에 sonnet을 주입하면 업그레이드가 된다. 훅은 frontmatter를 볼
  수 없다 → `exemptTypes`로 완화. 실피해는 "약간 더 비싼 모델" 수준.
- **(c) 트랜스크립트 JSONL은 비공식 포맷.** 버전 업데이트로 구조가 바뀌면 advisor가
  침묵한다(파싱 실패 = pass). 기능이 조용히 죽는 것을 감수한다 — 대신 세션은 절대
  안 깨진다.
- **(d) 휴리스틱은 휴리스틱이다.** "툴 없는 긴 설계 토론"은 가벼운 턴으로 집계되지만
  Fable이 값을 하는 작업일 수 있다. 그래서 강제가 아니라 제안이고, 세션당 1회다.
- **(e) 메인 모델은 끝내 유저 몫.** 훅에는 변경 수단이 없다. 이 모듈의 상한은
  "정확한 타이밍의 한 문장"이다.

---

## 9. 구현 전 실측 체크리스트 (전부 라이브로 확인할 것)

- [ ] 스폰 도구의 `tool_name`이 정확히 무엇인가 — `Task`? `Agent`? (matcher와
      스크립트 정규식 양쪽에 반영)
- [ ] `PreToolUse` + `updatedInput`이 Task 도구에서 실제로 먹는가 (스폰된
      서브에이전트의 실제 모델을 트랜스크립트/대시보드로 확인)
- [ ] **Workflow 내부 `agent()` 스폰이 PreToolUse 이벤트를 발생시키는가** (§8-a)
- [ ] 트랜스크립트 JSONL에 assistant `message.model` 필드가 현 버전에 존재하는가
- [ ] Stop 훅의 `systemMessage`가 UI에 실제로 렌더되는가
- [ ] `tool_input`에 `subagent_type`이 담겨 오는가 (exemptTypes 매칭 키)

---

## 10. 모듈 구성 & 와이어링

```text
core/model-guard/
├── subagent-guard.mjs     # PreToolUse(Task|Agent) — 강제 다운그레이드 (§3)
├── model-advisor.mjs      # Stop — 한 문장 제안 (§4)
├── lib/
│   ├── config.mjs         # .claude/model-guard.json 로드 + 내장 기본값 (§5)
│   ├── transcript.mjs     # tail-read + 턴 형태 분석 (§4)
│   └── ledger.mjs         # advisor 쿨다운 (§6)
├── DESIGN.md              # 이 문서
└── README.md              # 사용법 + env var 방식과의 양립 불가 명시 (§2)
```

`lib/hook-io.mjs`에 헬퍼 하나 추가 — `replaceToolOutput`(PostToolUse)과 대칭:

```js
/** PreToolUse: rewrite the tool input before it runs (exit 0 + stdout JSON). */
export function rewriteToolInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput },
  }));
  process.exit(0);
}
```

`hooks/hooks.json`에 두 항목:

```jsonc
"PreToolUse": [
  // ...기존 input-gate 항목...
  { "matcher": "Task|Agent",
    "hooks": [ { "type": "command",
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/core/model-guard/subagent-guard.mjs\"",
      "timeout": 10 } ] }
],
"Stop": [
  { "hooks": [ { "type": "command",
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/core/model-guard/model-advisor.mjs\"",
      "timeout": 15 } ] }
]
```

---

## 11. v1 구현 체크리스트

- [ ] §9 실측 6항목 먼저 (특히 tool_name과 Workflow 사각지대 — 설계 분기점)
- [ ] `lib/hook-io.mjs`에 `rewriteToolInput` 추가 (기존 export 불변)
- [ ] `core/model-guard/lib/{config,transcript,ledger}.mjs`
- [ ] `subagent-guard.mjs` + 합성 이벤트 테스트: model 부재→target 주입 / haiku 유지 /
      exemptTypes 통과 / 비대상 도구 pass / config disabled
- [ ] `model-advisor.mjs` + 합성 테스트: 가벼운 스트릭→발화 / 무거운 세션 침묵 /
      쿨다운 / 트랜스크립트 파싱 실패 침묵
- [ ] `hooks/hooks.json` 두 항목 + 최상위 README Modules 표 + 루트 DESIGN.md에 모듈 행
- [ ] 라이브 검증: 실제 서브에이전트 스폰 모델 확인 + advisor 한 문장 렌더 확인
- [ ] 버전 범프(minor) + PR
