# Claude Code 트랜스크립트 — 실증 레퍼런스

이 플러그인 모듈 절반이 트랜스크립트에 기댄다(ctx-budget의 사용률/귀속, 효과
측정 채굴, output-cap 마커의 감사 흔적). 이 문서는 **실물 관찰로 확정한** 포맷
지식을 모아둔다. 관찰 기준: Claude Code 2.1.198, 2026-07-04, 실제 컴팩션이
일어난 세션의 .jsonl.

> **규율:** 트랜스크립트 포맷은 CC 내부 구현이며 공개 계약이 아니다. 버전에
> 따라 변할 수 있으므로, 이를 파싱하는 모듈은 (1) 구현 전 실물 트랜스크립트로
> 마커/필드를 재확인하고("0단계"), (2) 파싱 실패 시 반드시 fail-open 한다.
> 우리는 **항상 읽기 전용** — 쓰는 것은 CC뿐이다.

## 정체와 위치

- 세션의 모든 사건을 **한 줄 = JSON 하나**로 기록하는 append-only JSONL.
- 경로: `~/.claude/projects/<작업폴더 인코딩>/<세션ID>.jsonl`
  (예: `/home/renoir/repo` → 디렉토리명 `-home-renoir-repo`).
- 모든 훅 이벤트에 `transcript_path`로 전달된다. **컨텍스트의 정체성**으로
  쓰기에 session_id보다 낫다 — 서브에이전트가 같은 세션에서 돌아도 컨텍스트가
  다르면 안전하게 구분해야 하기 때문(아래 sidechain 참고).

## 트랜스크립트 ≠ 컨텍스트

| | 트랜스크립트 | 컨텍스트 |
| --- | --- | --- |
| 정체 | 디스크의 전체 역사 | 매 턴 모델에 재전송되는 작업 기억 |
| 크기 | append-only, 계속 자람 | 컴팩션 때 줄어듦 |
| 컴팩션 시 | 지워지지 않음 — 경계 마커+요약 추가 | 경계 이전이 요약으로 대체 |

따라서 "파일에는 있지만 컨텍스트에는 없는" 구간이 존재한다. **컨텍스트 안의
현재 상태**를 추론하려면 반드시 마지막 컴팩션 경계 이후만 봐야 한다.

## 주요 엔트리 타입 (실측 분포 예: assistant 144 · user 88 · system 52 …)

- **`user`** — 사용자 입력과 **툴 결과**. `message.content[]`에
  `{type:"tool_result", tool_use_id, content}` 블록. output-cap이 작동한 경우
  여기 기록되는 것은 **교체본**(모델이 실제 받은 것)이다 — 귀속 계산이 별도
  보정 없이 정확한 이유이자, `output-cap: dropped N of M chars` 마커를 나중에
  합산해 실현 절감량을 측정할 수 있는 이유.
- **`assistant`** — 모델 응답. `message.content[]`에 text / thinking /
  `{type:"tool_use", id, name, input}` 블록. `message.model`, 그리고 아래의
  `message.usage`가 붙는다.
- **`system`** — 하위에 `subtype`. 핵심은 컴팩션 경계(아래).
- **CC 부기 타입** (버전 의존, 파싱하지 말 것): `file-history-snapshot`
  (Esc-Esc 되감기용), `pr-link`, `ai-title`, `last-prompt`, `mode`,
  `permission-mode`, `attachment` 등.

## 공통 필드

`uuid` / `parentUuid`(체인), `timestamp`(ISO), `sessionId`, `cwd`, `version`,
그리고 **`isSidechain`**.

### `isSidechain` — 서브에이전트 구분 (중요)

Task/Agent로 스폰된 서브에이전트의 트래픽은 `isSidechain: true`로 기록된다.
서브에이전트의 컨텍스트는 본체와 **별개**이므로:

- 본체 컨텍스트 크기를 잴 때 sidechain의 usage를 집으면 완전히 틀린 값이
  나온다 → ctx-budget은 `isSidechain !== true`인 엔트리만 사용.
- "이 파일을 이미 읽었나" 류의 판단도 sidechain 기록을 근거로 하면 안 된다.

## `message.usage` — 컨텍스트 크기의 근원

모든 assistant 엔트리에 그 턴의 토큰 회계가 붙는다. 실측 예:

```json
{ "input_tokens": 96, "cache_read_input_tokens": 241628,
  "cache_creation_input_tokens": 70, "output_tokens": 3175 }
```

- **현재 컨텍스트 크기 = input + cache_read + cache_creation** (마지막
  main-chain assistant 엔트리 기준). 위 예시면 ≈ 241.8k 토큰.
- 캐시 경제도 그대로 보인다: 새 입력 96토큰, 나머지는 캐시 읽기(기본 단가의
  ~1/10). 컴팩션은 이 캐시를 리셋한다(직후 첫 턴은 cache_creation, 1.25배).
- 성능: 파일이 수 MB여도 **꼬리 ~256KB만 seek-read**하면 최신 usage를 찾기에
  충분하다. ctx-budget이 매 툴콜마다 하는 작업이 이것뿐인 이유.

## 컴팩션 경계 — 실물 포맷

```json
{ "type": "system", "subtype": "compact_boundary",
  "content": "Conversation compacted", "isMeta": false,
  "compactMetadata": { "trigger": "manual", "preTokens": … },
  "logicalParentUuid": "…", "parentUuid": null, … }
```

- 판정 조건: `type === "system" && subtype === "compact_boundary"`.
- `compactMetadata.trigger`: `manual`(/compact) 또는 auto.
- 경계 **이후** 엔트리만 현재 컨텍스트에 존재한다. 귀속 스캔은 경계를 만나면
  누적을 리셋하는 방식으로 구현되어 있다(마지막 경계만 유효).

## 이 플러그인에서의 사용처 매핑

| 모듈/작업 | 읽는 부분 | 방식 |
| --- | --- | --- |
| ctx-budget 사용률 | 꼬리의 마지막 main-chain usage | 매 툴콜, seek-read 256KB |
| ctx-budget 귀속 | 마지막 경계 이후 tool_use/tool_result 쌍 | 경보 발화 시에만 전체 스트림 |
| 효과 측정(채굴) | 전 세션의 Read 쌍, output-cap 마커 | 오프라인 스크립트 |
| read-once(기각됨) | 경계 이후 Read 생존 확인 (설계만) | — |

## 알려진 주의점

- **마이크로컴팩션/컨텍스트 편집**: 최신 CC는 경계 마커 없이도 오래된 툴
  결과를 정리할 수 있다. "경계 이후 = 컨텍스트에 있음"은 근사이며, 정밀함이
  필요한 판단에는 TTL 같은 백업 조건을 함께 걸 것.
- usage는 직전 assistant 턴 기준이라 반 턴 정도 지연이 있다.
- 토큰 근사는 chars/4 — 순위 판단에는 충분, 절대값은 대략적.
