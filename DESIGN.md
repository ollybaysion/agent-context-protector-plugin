# agent-context-protector-plugin — 설계 / 구현 계획

> **Status: 계획 단계 (구현 미착수).**
> 근거: claude-hooks 예산 리서치 워크플로우 — 30개 전략 도출, 적대적 검증 통과 26개.
> 이 문서는 "무엇을, 어떤 순서로, 어떤 메커니즘으로" 만들지를 확정한다. 코드는 아직 없다.

## 1. 왜 별도 플러그인인가

`claude-hooks`는 잡다한 개인 훅 모음(lint, tdd-guard, git-guard, observability, ...)이다.
컨텍스트/토큰 예산 보호는 응집도 높은 **독립 관심사**이고 모듈이 5~6개 필요하다. 이걸
`claude-hooks`에 얹으면 플러그인이 비대해지고 토글/버전/배포가 엉킨다.

→ 별도 플러그인 **`agent-context-protector`** 로 분리한다. 에이전트의 컨텍스트 창을
bloat(거대 툴 출력·통째 read·대형 diff·firehose 로그)로부터 보호하는 것이 유일한 책임.

## 2. 목표 / 비목표

**목표:** 세션 토큰/컨텍스트 예산을 **하드 레버**로 실제 감소시킨다.

- 하드 레버 = ① 결과가 컨텍스트에 들어오기 *전에* `deny` 게이트, ② 실행 후 *커밋 전에* 출력 치환.

**비목표(하지 않음):**

- `/compact` 강제 트리거 — 불가능(§4 함정 3).
- 연성 넛지만으로 절감을 기대하는 것 — 넛지는 보조 신호일 뿐.

## 3. 토큰이 어디로 가는가 (레버 우선순위)

한 세션 토큰의 대부분은 **툴 결과가 컨텍스트로 유입**되는 데서 나온다(거대 Bash stdout,
통째 Read, 대형 diff). 매 턴 전체 컨텍스트가 재전송되므로 한 번 들어온 대형 결과는
압축 전까지 매 턴 비용이 된다. 따라서:

| 레버 | 지점 | 신뢰도 | 비고 |
| --- | --- | --- | --- |
| (A) PreToolUse `deny` 게이트 | 유입 *전* | 최고 | `bash-guard`/`git-guard`가 이미 쓰는 검증된 방식 |
| (B) PostToolUse `updatedToolOutput` | 실행 후 / 커밋 *전* | 높음 | CC ≥ v2.1.121. 현재+이후 턴 모두 절감하는 유일한 사후 레버 |
| (C) systemMessage / additionalContext 넛지 | — | 낮음(간접) | 그 자체론 토큰을 못 줄임 |

**가장 강력한 조합 = (A) + (B).** 이 플러그인의 MVP는 이 둘로만 구성한다.

## 4. 핵심 설계 제약 — 3대 함정 (반드시 준수)

1. **`updatedInput`(명령 재작성) 전략은 신뢰 불가 → 절대 사용 안 함.**
   여러 PreToolUse 훅이 같은 툴 호출에 매칭되면 `updatedInput`이 무시된다(멀티-훅, #15897).
   `claude-hooks`의 `send-event`가 PreToolUse `matcher:"*"`로 모든 툴에 걸려 있어, 두 플러그인이
   함께 설치된 한 이 조건은 항상 성립한다. 또 `updatedInput`은 `permissionDecision:"allow"`가
   있어야 적용되는데, 이는 해당 명령을 **자동 승인**(권한 프롬프트 우회)하는 부작용 → "pass는
   auto-approve가 아니다"라는 훅 철학과 충돌. **결론: 입력 재작성 대신 `deny` 게이트 +
   PostToolUse `updatedToolOutput`.**
2. **`ask`는 예산 절감이 불확실 → `deny` 우선.**
   `ask`의 reason은 *사용자에게만* 표시되고 모델엔 안 간다. 승인하면 firehose가 그대로 유입되고,
   bypass-permissions 모드에선 스킵된다. 실제로 토큰을 아끼려면 `deny`(reason이 모델로 가서
   "범위를 좁혀 재시도"를 유도). `ask`는 부작용 있는 명령의 인간 게이트 용도로만.
3. **어떤 훅도 `/compact`를 강제 못 한다** (`triggerCompact` 같은 필드 없음).
   압축 관련 전략은 전부 "리마인드 / 인에이블"에 그친다.

## 5. 아키텍처

`claude-hooks` 컨벤션을 계승한다.

```text
agent-context-protector-plugin/
├── .claude-plugin/
│   ├── plugin.json          # name/version/author (신규)
│   └── marketplace.json     # 배포 매니페스트 (신규)
├── hooks/
│   └── hooks.json           # 모듈 배선 (이벤트별 한 줄씩)
├── lib/
│   └── hook-io.mjs          # claude-hooks에서 가져오되 신규 헬퍼 추가
├── core/
│   ├── input-gate/
│   ├── output-cap/
│   ├── read-once/
│   ├── ctx-budget/
│   └── transcript-vault/
├── AGENTS.md                # 모듈 계약 (claude-hooks 것 계승)
└── README.md
```

**`lib/hook-io.mjs` — 신규 헬퍼 추가** (현재 `emitDecision`은 PreToolUse deny/ask만 지원):

- `replaceToolOutput(obj)` — `{hookSpecificOutput:{hookEventName:"PostToolUse", updatedToolOutput:<obj>}}` stdout + exit 0.
- `emitSystemMessage(msg)` — `{systemMessage: msg}` (사용자 UI 경보용).
- `emitAdditionalContext(eventName, text)` — `{hookSpecificOutput:{hookEventName, additionalContext:text}}`.

**규율(계승):**

- exit-code: `exit 2`만 block. 그 외 non-zero는 fail-open(무시). `exit 2` + stdout JSON **혼용 금지**.
- 상태 파일은 `os.tmpdir()`(세션별) 하위. **`CLAUDE_PLUGIN_ROOT` 아래 금지**(업데이트마다 바뀜).
- 모든 모듈: `readHookInput()` 시작 → `tool_name`/경로 조기 필터 → 예외는 `failOpen()`.
- PostToolUse는 모든 툴콜에 돌 수 있으니 가볍게(무거운 검사 금지).

## 6. 모듈 (응집 구성 — "모듈 너무 많음" 해소)

관심사를 응집해 **5개**로 줄인다(초기 리서치의 12개 세분 모듈 → 응집). 각 게이트 규칙은
모듈 내부의 **규칙 테이블**로 유지해 파일 수 대신 데이터로 확장한다.

### 6.1 `input-gate` — PreToolUse (Bash + Read) · [MVP, 최우선]

결과가 컨텍스트에 들어오기 전 firehose를 `deny`로 차단하고, 경계 대안을 reason에 담아 모델이
자동 재시도하게 한다. 흡수한 전략: fs-traversal / firehose-log / git-diff-volume /
remote-payload / output-volume(Read+Bash 뷰어). **`bash-guard`/`git-guard`와 직교한 규칙만**
(중복 회피). 규칙 테이블:

| 카테고리 | 트리거(예) | 조치 | 대안 제시 |
| --- | --- | --- | --- |
| 재귀 순회 | `ls -R`, `tree` w/o `-L`, `du` w/o `-s`/`-d` | deny | `ls DIR`(1단계), `fd -t d -d2`, `tree -L2`, `du -sh` — ※`ls -L`은 depth가 아니라 심링크 역참조라 대안 불가(구현 검증에서 정정) |
| follow 모드 | `tail -f`, `journalctl -f`, `docker/kubectl logs -f`, `pm2 logs`(기본 스트리밍, `--nostream` 필요) — 타임아웃까지 hang이므로 파이프 여부 무관 deny | deny | `-n 200` / `--tail 200` / `--nostream` |
| 무제한 로그 | `journalctl`/`docker logs`/`kubectl logs` w/o `--tail`·`-n` | deny | `--tail 200` / `-n 200` |
| 대형 diff | `git log -p` w/o 개수 제한; `git diff` → `--shortstat`로 실측 후 임계 초과(단순형만, 복합/확장 구문은 pass) | deny | `--stat` 후 파일별 |
| 원격 페이로드 | `curl` 무분기 body; `wget`은 **`-O-`(stdout 모드)만** — 기본 동작은 파일 저장이라 무해(구현 검증에서 정정) | deny | 파일 저장 후 `jq`/부분 read |
| 대용량/생성물 read | `offset`/`limit` 없고 `statSync` > ~256KB, 또는 생성물(`*.min.js`, `*-lock.*`, 단일라인 blob) | deny | `rg`/`jq`/페이징 read |

- 파싱/경로 불확실(상대·glob·변수) → `pass()`/`failOpen()`(fail open). 같은 이유로
  `rg -uu` 규칙(명시 경로 유무 파싱 불가)은 구현에서 제외(구현 검증에서 결정).
- 파이프/리다이렉트가 있으면 하류에서 바운딩될 수 있으므로 volume 규칙은 pass
  (follow 모드는 예외 — 파이프여도 hang).
- 정직한 한계: CC가 이미 초대형 read를 "부분 뷰 첫 페이지"로 절단하므로 실질 이득은
  대형 페이지 1개 + 줄번호 오버헤드(~70%) 회피 + rg/jq 유도. 그래도 유효.

### 6.2 `output-cap` — PostToolUse (Bash) · [MVP]

실행 후 컨텍스트 커밋 전 초대형 stdout을 치환. strip-noise 흡수.

- 순서: ① 노이즈 제거(ANSI 이스케이프·`\r`·연속 빈줄 붕괴 — **무손실**) → ② 여전히 크면
  **문자수 예산**으로 head N + tail N + `[dropped M lines / ~K tok; 범위 좁혀 재실행]` 노트로 축약.
- **주의:** 빌트인 Bash `tool_response`는 `{stdout,stderr,interrupted,isImage}` **객체**다. bare
  string으로 치환하면 무시된다 → 원본을 clone해 문자열 필드만 축약, **stderr/에러 줄은 항상 보존**.
- `replaceToolOutput()` 사용. **exit 2 절대 금지**(stdout 폐기됨).
- 버전: CC ≥ v2.1.121 필요(이전 버전은 무해한 no-op).
- 감사로그: 원본이 필요하면 별도 파일 로깅(선택). (`claude-hooks` 미설치 환경 대비.)

### 6.3 `read-once` — PreToolUse (Read) · [**기각 — 기회 크기 측정 탈락, 2026-07-04**]

> **기각 근거 (실측):** 로컬 트랜스크립트 29개 전수 채굴 결과, 동일 세션 내
> 중복 read(같은 경로+범위)는 전체 Read 트래픽의 **1.6%** — 19회 / 20,090자
> ≈ 5,000토큰(전 역사 합계), 세션당 **~43토큰**. 이것도 상한(파일 변경 후·
> 컴팩션 후의 정당한 재-read 포함). 대상도 소형 설정 파일뿐. 반면 이 모듈은
> 플러그인 전체에서 오탐 리스크(컴팩션 후 필요한 read 차단→잘못된 수정)와
> 구현 복잡도(트랜스크립트 스캔+상태)가 최대다. **최소 이득에 최대 리스크 —
> 만들지 않는 것이 옳다.** 하네스가 "수정 후 재-read 불필요" 리마인더로 이미
> 중복을 억제하고 있는 것이 낮은 기회의 원인으로 보인다. 아래 원 설계는
> 기록용으로 남긴다.

같은 파일을 이미 컨텍스트에 넣었으면 재-read를 `deny`("위 내용을 재사용하라").

- 상태: `os.tmpdir()/acp/read-cache/<session_id>.json` = `{path, mtime, size, offset, limit, ts}`.
  현재 read의 경로+mtime+size 일치 AND 요청 범위가 이미 커버됨 → deny.
- **핵심 보정:** TTL만으로 판단하면 **압축 후**(원본은 사라졌는데 타이머는 "신선") 필요한 read를
  막아 역효과. `transcript_path`를 스캔해 그 read 결과가 *마지막 압축 경계 이후에도* 살아있을 때만
  deny(mtime/범위는 빠른 사전필터, TTL은 백업).
- 안티-핑퐁: 직전이 동일 경로 read-once deny였으면 `pass()`. `deny`는 bypass 모드에서도 유효.

### 6.4 `ctx-budget` — PostToolUse (`*`) · [phase 2, 관측/넛지 — 스펙 확정 2026-07-04]

컨텍스트 사용량을 가시화하고 임계에서 `/compact`를 리마인드(강제 아님).

- 트랜스크립트 꼬리의 마지막 main-chain usage(input+cache_read+cache_creation)
  → % 계산(`ACP_CTX_BUDGET_WINDOW`) → `emitSystemMessage()`로 **10% 티어마다
  1회** 경보(상향 교차 시만, 컴팩션으로 하락하면 사다리 리셋). 경계/usage 포맷은
  `docs/transcript.md`(실증) 참조. sidechain(서브에이전트) usage 제외.
- **50%부터** 경보에 `/compact` 권고 + 귀속(마지막 컴팩션 경계 이후 상위 소비
  툴콜 3개) 부착. Stop 이벤트 대신 경보 발화 시점에 귀속을 붙이는 것으로 단순화.
- **사용자의 원래 아이디어("PR 머지 후 `/compact` 리마인드")의 강화판이 여기 들어간다:**
  머지 큐 + **"컨텍스트가 이미 ~50% 이상일 때만" 발화**하도록 threshold로 게이팅 → 깨끗한 의미
  경계 + 실제 예산 신호를 함께 만족(§8 참고). 머지 감지는 2경로: 세션 내 `gh pr merge`(에이전트
  머지 금지 워크플로우에선 휴면 — git-guard가 deny하면 PostToolUse 미발화) + **머지 증거**(새
  커밋을 실제로 가져온 `git pull` 출력) — 사람이 머지하는 워크플로우의 실신호는 후자다.
- 한계: 넛지는 간접 효과. 그 자체론 토큰을 못 줄인다.

### 6.5 `transcript-vault` — PreCompact · [phase 3, 인에이블러]

압축 전 `fs.copyFile(transcript_path)`로 백업 → 공격적 압축을 안전하게(정보 손실 걱정↓).

- **주의:** 압축 후 볼트 경로를 모델에 재노출하는 것은 플러그인 스코프 additionalContext 버그
  (#16538/#20659)로 안 됨 → **백업까지만.** 재노출이 꼭 필요하면 `~/.claude/settings.json`으로
  옮겨야 하나 플러그인 계약 위배라 보류.

### 6.6 `frugal-directive` — SessionStart · [optional]

`source ∈ {startup, resume, clear, compact}`에 ~120토큰 절약 헌장을 `additionalContext`로 주입
(bounded 검색 선호, 파일 덤프 회피, 큰 fan-out은 subagent 위임). **버전 의존적** — 플러그인 스코프
SessionStart 주입이 현행 버전에서 모델에 보이는지 먼저 확인 후 채택.

## 7. 구현 로드맵

- **Phase 0 — 스캐폴딩:** `plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json` 뼈대,
  `lib/hook-io.mjs`(+ 신규 헬퍼 3종), `AGENTS.md`/`README.md`.
- **Phase 1 — MVP(하드 레버):** `input-gate` + `output-cap`. 절감의 대부분을 여기서 확보.
- **Phase 2 — 상태/관측:** ~~`read-once`~~(기각, §6.3) + `ctx-budget`.
- **Phase 3 — 인에이블러:** `transcript-vault`, 그리고 `frugal-directive` 실험.

각 단계는 별도 PR. (main 직접 푸시 금지 — 브랜치+PR.)

## 8. 사용자의 원래 아이디어 위치 정리

"PR 머지 후 `/compact` 리마인드"는 **예산 목적이라면 threshold 방식이 더 정확**하다.
머지 시점 ≠ 컨텍스트가 큰 시점 — 머지가 컨텍스트 작을 때 오면 압축은 순손실(요약 토큰 +
재사용 가능한 캐시 폐기 + 이득 0), 반대로 머지 없이 auto-compact를 넘길 수도 있다. 예산 절감은
"컨텍스트가 실제로 클 때 압축"에서만 나온다.

단 **상호배타 아님:** PR 머지는 의미적으로 깨끗한 경계라 `/compact` 품질엔 좋은 큐다.
→ **최선은 결합**: `ctx-budget`에서 머지 리마인드를 "그리고 컨텍스트 ≥~50%일 때만" 발화하도록
게이팅. 둘 다 리마인드일 뿐 `/compact`를 강제하진 못한다는 한계는 동일.

## 9. 구현 금지 (검증에서 탈락)

- **quiet-exec**(updatedInput로 `-q` 삽입) — 함정 1로 완전 no-op.
- **compress-failures**(PostToolUseFailure에서 에러 덤프 압축) — 이 이벤트는 `updatedToolOutput`
  미지원(additionalContext만 → 오히려 토큰 증가). 실패 Bash는 PostToolUse로 안 옴.
- **compact-carryover**(PreCompact `additionalContext` 주입) — PreCompact는 additionalContext 미지원 +
  압축 전이라 요약기에 삼켜짐 → 대안은 SessionStart `source==="compact"`.
- **플러그인 스코프 additionalContext 재노출** — 주입 버그로 모델이 못 봄.
- **`/compact` 강제** — 불가능.

## 10. claude-hooks와 공존 시 주의

- `input-gate`/`read-once`의 `deny`는 `bash-guard`/`git-guard`와 **직교 규칙만**(grep→rg, find→fd,
  git 보호 등은 이미 claude-hooks가 처리 → 중복 금지).
- `updatedInput` 함정은 `send-event`(PreToolUse `*`) 설치 시 지속 → 애초에 `updatedInput` 안 쓰므로 무관.
- `output-cap`이 원본을 축약해도 `claude-hooks`의 `send-event`(PostToolUse `*`)가 원본 `tool_response`를
  대시보드에 남긴다 → 감사로그 유지. (단 두 PostToolUse 훅의 실행 순서/입력 전달 방식은 구현 전 확인 필요.)

## 11. 근거

리서치 워크플로우(6각도 조사 → 전략별 적대적 실현가능성 검증 → 합성): **30개 전략 중 26개**가
검증 통과. 상세 원본 리포트는 요청 시 `docs/budget-hooks-research.md`로 별도 보존 가능.
