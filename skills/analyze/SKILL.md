---
name: analyze
description: 토큰 지출 진단 리포트 — 트랜스크립트를 오프라인 분석해 전체 비용, 패턴별 지출, 룰 제안을 요약한다. 사용자가 "/analyze", "토큰 분석", "지출 리포트", "뭐가 토큰 먹었지" 등으로 명시적으로 요청할 때만 발동. 훅 절감 효과·비효율을 물으면 --plugin-report를 추가한다. 인자 [--project <dir> | all] [--since <ISO>] [--top N] [--precise] [--plugin-report] [--json <path>]는 CLI로 그대로 전달.
---

# analyze — 토큰 지출 진단

트랜스크립트(`~/.claude/projects/*/*.jsonl`)를 읽기 전용으로 채굴하는 CLI를
실행하고, 결과를 해석해 요약한다. CLI 상세는
[core/analyze/README.md](../../core/analyze/README.md).

## 실행 절차

1. **CLI 경로**: 이 스킬의 base directory 기준 `../../core/analyze/analyze.mjs`.

2. **프로젝트 범위 결정**:
   - 인자에 `--project`가 있으면 그대로 쓴다.
   - 인자에 `all`이 있으면 `--project` 없이 실행한다(전체 프로젝트).
   - 둘 다 없으면 현재 작업 디렉토리를 CC 인코딩 규칙(`/` → `-`)으로 변환해
     `--project`로 넘긴다. 예: `/home/renoir/repo` → `-home-renoir-repo`.
     해당 디렉토리가 `~/.claude/projects/`에 없으면 `fd -t d . ~/.claude/projects
     --max-depth 1`로 실제 이름을 확인한다.

3. **실행**: `node <CLI 경로> --project <dir> <나머지 인자>` — `--top`은
   지정이 없으면 15. `--precise`는 사용자가 명시했을 때만(느림).
   **`--plugin-report`는 사용자가 훅의 절감 효과·플러그인 효율을 물을 때만**
   추가한다("훅이 얼마나 막았어", "절감 효과", "비효율 없어?") — 기본
   리포트는 훅 미설치 환경에서도 성립하는 범용 분석이다.

4. **해석해서 보고** (원문 통째 덤프 금지 — 리포트는 해석이 가치다):
   - 비용($): 총액과 최대 비용 항목(대개 cache reads)을 한 줄로. **API 단가
     환산 참고치**임을 명시한다 — 구독(Max) 사용자는 실청구액이 아니다.
     unpriced 모델 행이 있으면 그대로 전달한다.
   - 상위 패턴 3~5개: 숫자와 함께 **의미**를 붙인다 ("Read(*.md)가 14% —
     문서 통읽기가 최대 소비").
   - **proposals 섹션이 있으면 반드시 전달** — 다음 input-gate 룰 후보가
     여기서 나온다. 각 제안에 대해 채택/보류 의견을 한 줄씩 붙인다.
   - `--plugin-report`를 썼다면: 모듈별 절감액(실측 잔여 턴 기반 $)과
     비효율 진단(gate-promotion / no-retry / quiet-rules)을 해석해 전달.
     deny는 $ 정량 불가(사전 차단)임을 함께 말한다. "hooks appear inactive"
     안내가 나오면 이 기간엔 훅이 꺼져 있었다고 전달한다.
   - 마지막에 다음 액션 1~2개를 권고한다 (예: "룰 추가", "습관 교정",
     "임계 조정").

## 주의

- CLI는 읽기 전용이며 훅이 아니다 — 이 스킬은 실행·해석만 한다. 리포트를
  근거로 한 룰 추가 등 코드 변경은 사용자 확인 후 별도 작업으로.
- `--json`을 요청받으면 경로를 그대로 전달하고 파일 위치만 알려준다.
