# Unity Personal single-seat handoff

이 문서는 Unity Personal의 Editor 한 자리로 여러 프로젝트를 다루는 운영 계약이다. 목표는
여러 checkout의 코드 작업을 병행하되 Unity import, recompile, test, build와 그 증거 수집은
machine-wide **validation turn** 하나로 직렬화하는 것이다. Editor를 동시에 두 개 띄우는
우회가 아니다.

## 동시성 계약

- Unity Editor는 machine 전체에서 최대 1개다. 설정은 `license.mode=single-seat`,
  `license.maxConcurrentEditors=1`을 유지한다.
- 서로 다른 repository의 source 편집은 병행할 수 있다. Editor가 열리지 않은 프로젝트도
  일반 파일 도구와 Git으로 편집할 수 있다.
- 같은 repository의 동시 writer는 금지한다. 이 충돌은 router가 아니라 agent ownership,
  worktree와 Git coordination으로 막는다.
- Unity import/recompile/test/build, Game View 증거와 최종 Console 확인은 validation turn을
  획득한 agent만 수행한다. Codex와 Claude Code 모두 같은 규칙을 따른다.
- inactive project의 `editor_status` 같은 safe read도 자동으로 Editor를 깨우지 않는다.
  `PROJECT_EDITOR_INACTIVE`가 정상 결과이며, validation turn 또는 명시적 admin switch를 먼저
  요청한다.

## 기본 설정

1차 운영 모드는 다음과 같다.

```json
"license": {
  "mode": "single-seat",
  "maxConcurrentEditors": 1
},
"editorHandoff": {
  "mode": "manual-close",
  "pollIntervalMs": 500,
  "editorExitTimeoutSec": 180,
  "startupTimeoutSec": 900
}
```

`manual-close`에서 broker는 기존 Editor를 종료하지 않는다. 다른 프로젝트의 Editor가 열려
있으면 전환 상태가 `WAITING_MANUAL_CLOSE`가 되고, 사용자가 Unity의 정상 Close를 완료한 뒤
기존 exact PID가 사라진 것을 확인한다. 그 다음에만 target canonical path를 `unity open`으로
정확히 한 번 실행하고 Pipeline readiness까지 기다린다.

## Codex와 Claude의 validation turn

MCP session이 직접 turn을 소유할 때의 순서다.

1. `unity_router_workspace_begin({"project":"PROJECT_ALIAS","ttlSec":600})`을 호출한다.
2. 반환된 `token`을 먼저 보존하고 `editorUse.state`와 `editorUse.operationId`를 검사한다.
3. operation ID가 non-null이고 handoff가 nonterminal이면 lease TTL 전에
   `unity_router_workspace_heartbeat`를 호출하면서
   `unity_router_editor_use_status({"operationId":"UUID"})`를 폴링한다.
4. `WAITING_MANUAL_CLOSE`이면 사용자가 현재 Editor를 정상 Close한다. 저장, 폐기, Play 정지,
   modal 응답을 agent가 추측해서 대신하지 않는다.
5. `COMPLETED` 뒤 exact project path, Pipeline ready, compile/import 종료와 Play Mode 정지를
   확인한 다음 필요한 import/recompile/test/build를 실행한다.
6. tracked async가 terminal이고 compile/import가 멈춘 뒤
   `unity_router_workspace_end({"leaseToken":"TOKEN"})`로 turn을 반납한다.

operation ID가 null/누락됐거나 `BLOCKED`, `CANCELLED`, `FAILED`, `UNKNOWN_OUTCOME`처럼
`COMPLETED`가 아닌 terminal이면 validation을 시작하지 않고 원래 token으로 즉시
`workspace_end`한다. end가 `WORKSPACE_EDITOR_HANDOFF_ACTIVE`이면 lease를 계속 heartbeat하고,
오류 응답의 `editorUse.operationId`를 terminal까지 조회한 뒤 end를 재시도한다. end 실패나 owner
session 유실은 workspace status/recovery/admin reconciliation으로 해소하며 TTL이 retained lease를
고아 상태로 만들 때까지 방치하지 않는다. blocker 또는 불확실한 operation을 먼저 reconcile하고
같은 close/open이나 Unity mutation을 다시 보내지 않는다.

### CLI guard

shell 기반 validation driver는 설치된 `router-cli` guard가 handoff 대기, heartbeat와 release를
한 프로세스에서 소유하게 한다.

```sh
ROUTER_HOME=/Users/zamgune/.unity-mcp-router
NODE_BIN=$(/usr/bin/sed -n '1p' "$ROUTER_HOME/current/node-bin.txt")
RELEASE_ID=$(/usr/bin/sed -n '1p' "$ROUTER_HOME/current/release-id.txt")
ROUTER_CLI="$ROUTER_HOME/releases/$RELEASE_ID/router-cli.mjs"
ROUTER_CONFIG="$ROUTER_HOME/current/config.json"

"$NODE_BIN" "$ROUTER_CLI" \
  --config "$ROUTER_CONFIG" --broker-mode connect-only \
  workspace guard PROJECT_ALIAS -- VALIDATION_COMMAND ARGUMENTS
```

`VALIDATION_COMMAND`는 실제 repository의 승인된 validation driver로 바꾼다. 저장소에 없는
예시 wrapper를 그대로 실행하지 않는다. guard는 Editor handoff가 `COMPLETED`되기 전에는
command를 시작하지 않고, command 종료 뒤 turn을 반납한다. guard 안에서 별도 router CLI나
adapter를 중첩해 다른 MCP session을 만들지 않는다. MCP tool validation은 turn을 소유한 원래
Codex/Claude session에서 위 직접 흐름을 사용한다.

## 운영자용 standalone Editor switch

단순히 다음 작업을 위해 Editor를 미리 맞춰 둘 때만 사용한다.

```sh
ROUTER_ADMIN=/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin

"$ROUTER_ADMIN" editor use SlashNClaim
"$ROUTER_ADMIN" editor status EDITOR_USE_UUID
```

`editor use`는 추적 가능한 handoff를 예약하지만 validation turn은 예약하지 않는다. 완료 직후
다른 Codex/Claude가 turn을 가져갈 수 있으므로 test/build의 상호 배제 수단으로 쓰면 안 된다.
운영 명령은 첫 JSON 응답의 `result.operationId`를 두 번째 명령에 넣고 terminal state까지
조회한다.

## handoff 상태와 blocker

주요 non-terminal 상태는 다음과 같다.

| 상태 | 의미와 행동 |
| --- | --- |
| `PRECHECK` | queue, lease, journal, process audit와 project identity를 검사 중 |
| `WAITING_MANUAL_CLOSE` | 현재 Editor를 사용자가 정상 Close해야 함 |
| `QUIT_DISPATCHED` / `WAITING_OLD_EDITOR_EXIT` | typed close가 한 번 전달됐거나 기존 PID 종료를 관찰 중 |
| `OPEN_DISPATCHED` / `WAITING_TARGET_PROCESS` | exact `unity open`을 한 번 전달했고 target PID를 관찰 중 |
| `WAITING_PIPELINE` / `WAITING_IMPORT` | target Editor는 보이나 Pipeline/import/compile이 아직 준비되지 않음 |
| `COMPLETED` | exact target Editor와 Pipeline이 validation에 사용 가능한 상태 |

전환은 다음 조건에서 fail-closed한다.

- broker queue, response ACK, background operation, global lease 또는 다른 validation turn이 활성;
- unresolved `UNKNOWN_OUTCOME` 또는 recovery fence;
- Editor가 2개 이상이거나 PID/project path/canonical identity가 정확하지 않음;
- target volume 접근 또는 prepared `dev/inode` identity 불일치;
- typed status에서 compile/update, Play 또는 Play 전환, dirty/untitled scene, 열린 Prefab Stage,
  dirty Prefab Stage가 확인됨;
- close/open 전달 여부나 target process 결과가 독립적으로 확정되지 않음.

`manual-close`에서는 dirty scene이나 modal을 broker가 클릭하지 않는다. Unity가 표시한 저장
질문은 사용자가 판단한다. 작업물을 저장하거나 폐기하지 않은 채 자동화를 계속하지 않는다.

## typed auto-close 계약과 승인 gate

`typed-auto-close`는 구현이 존재한다는 이유만으로 운영 승인되지 않는다. typed command의
허용 계약은 다음 두 개뿐이다.

- `zamgune_handoff_status`: exact project path/PID, compile/update, Play 전환, 열린 scene의
  dirty/untitled 상태와 Prefab Stage 상태를 구조화해 반환한다.
- `zamgune_editor_close(expectedProjectPath, expectedPid, transitionId)`: 세 identity가 일치하고
  blocker가 0일 때만 응답 전달 뒤 Unity `File/Close`를 한 번 예약한다.

close 직전에도 상태를 다시 검사한다. 이 경로는 save, discard, Play stop, modal click,
`TERM`, `KILL`을 절대 수행하지 않으며, delivery uncertainty 뒤 close나 open을 재전송하지
않는다.

다음 gate를 모두 통과하기 전에는 `editorHandoff.mode`를 `typed-auto-close`로 바꾸지 않는다.

1. 다섯 프로젝트의 embedded `com.zamgune.unity-pipeline-compat`가 같은 승인 버전과
   Pipeline `0.4.0-exp.1` lock으로 동기화됨.
2. disposable project에서 dirty/untitled scene, dirty/open Prefab Stage, Play/전환,
   compile/update, PID/path/transition mismatch가 모두 close 0회로 끝나는 negative test 통과.
3. close 응답 단절, broker restart와 target open 불확실성에서 side effect 재전송 0회 및
   `UNKNOWN_OUTCOME` fence를 확인.
4. clean project A -> B -> A live canary에서 매 구간 Editor PID 1개, exact canonical path,
   readiness, Console clean과 operation/lease clean closeout을 확인.

## `UNKNOWN_OUTCOME` reconciliation

close 또는 `unity open`은 side effect다. dispatch 뒤 연결이 끊기면 성공/실패를 추측하거나
재시도하지 않는다.

```sh
ROUTER_ADMIN=/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin

"$ROUTER_ADMIN" editor status EDITOR_USE_UUID
"$ROUTER_ADMIN" operation status EDITOR_USE_UUID
```

process audit의 exact Editor PID/project path, Unity Console/Pipeline, project filesystem과 실제
side effect를 독립 확인한다. 완료가 입증된 parent UUID만 resolve한다. `confirmed_completed`
parent resolution은 broker가 내부 `:open` record를 먼저 함께 해소하므로 suffix id를 직접
입력하지 않는다.

```sh
"$ROUTER_ADMIN" operation resolve EDITOR_USE_UUID confirmed_completed
```

operation이 아직 `RUNNING`으로 남았지만 side effect와 관련 process가 terminal임을 별도로
입증한 경우에만 다음 확인 옵션을 쓴다.

```sh
"$ROUTER_ADMIN" operation resolve EDITOR_USE_UUID confirmed_completed \
  --confirm-no-longer-running
```

증거가 모호하면 fence를 유지한다. journal이나 workspace lease 파일을 직접 편집하지 않는다.

## rollout, canary와 rollback

### 1차 `manual-close` rollout

1. config/license가 `single-seat/1`과 `manual-close`인지 확인한다.
2. 각 프로젝트의 현재 Pipeline/embedded snapshot/lock 조합이 호환되는지 확인한다. 다섯
   snapshot의 동일 버전은 이 rollout의 선행조건이 아니며, typed close를 호출하지 않는다.
3. router unit/integration/installer test와 현재 호환 조합의 Editor smoke를 각각 기록한다.
4. installer dry-run과 staging을 통과한 뒤 immutable live deployment를 설치한다.
5. `doctor`에서 broker 1개, unmanaged MCP 0개, Editor 0~1개, canonical identities 5개를 확인한다.
6. disposable하거나 clean한 두 프로젝트로 A -> B -> A를 수행한다. 각
   `WAITING_MANUAL_CLOSE`에서만 사용자가 정상 Close하고, router가 target을 한 번 여는지
   확인한다.
7. Codex와 Claude가 각각 validation turn을 요청해 직렬화되는지, inactive safe read가
   Editor를 자동 실행하지 않는지 확인한다.
8. 종료 시 queue, delivery ACK, lease, workspace lease, background operation,
   `UNKNOWN_OUTCOME`가 모두 0이고 `processAudit.ok=true`인지 기록한다.

기존 2026-08-03의 5-project sequential canary와 one-Editor/two-client soak는 broker routing과
single-Editor 안정성 증거다. 새 handoff queue의 `manual-close` A -> B -> A, dirty/modal 무자동처리,
장애 복구를 증명하지 않는다. source/fake test만 통과한 candidate도 live handoff 승인으로
승격하지 않는다.

### rollback

새 operation을 중단하고 active handoff/validation turn이 terminal인지 확인한 뒤 drain한다.

```sh
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin drain --timeout-sec 60
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-rollback \
  --drain-timeout-sec 60 \
  --verify-timeout-sec 30
```

`WAITING_*`, `QUIT_DISPATCHED`, `OPEN_DISPATCHED`, unresolved workspace lease 또는
`UNKNOWN_OUTCOME`가 남아 있으면 rollback을 강행하지 않는다. 독립 검증과 reconciliation 뒤
다시 drain한다. rollback 뒤에도 Unity Personal Editor 한 자리와 동일한 Codex/Claude
project-local adapter 계약을 유지한다.
