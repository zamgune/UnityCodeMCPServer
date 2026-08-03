# unity-mcp-router 운영·롤아웃 가이드

이 문서는 “여러 agent와 프로젝트가 동시에 요청해도 잘못된 Editor로 보내지 않고, mutation을 중복 실행하지 않으며, 장애 뒤 상태를 추측하지 않는다”를 완료 기준으로 삼는다. 기능 구현, fake test, launchd 설치, 실제 Unity canary와 soak는 서로 다른 검증 계층이며 하나의 통과 결과로 다른 계층을 대체하지 않는다.

이 절차의 2026-08-03 실제 수행 결과는 [VALIDATION-2026-08-03.md](VALIDATION-2026-08-03.md)에 기록했다. 절차 문서의 빈 표는 다음 rollout용 템플릿이며, 검증 기록의 실제 결과를 대신하지 않는다.

## 최종 목표와 완료 조건

| 목표 | 완료 조건 |
| --- | --- |
| broker single ownership | `launchd` job 1개, broker PID 1개, 모든 Codex/Claude adapter가 connect-only |
| 정확한 project routing | 5개 checkout의 canonical identity가 겹치지 않고 cross-project misroute 0건 |
| bounded concurrency | same-project single-flight, default global heavy 1, source-refresh writer 1, queue overflow/deadline이 명시적 오류 |
| mutation integrity | dispatch 뒤 automatic mutation replay 0건, adapter 전달 ACK 전 `DELIVERING`, 미확정 결과는 durable `UNKNOWN_OUTCOME` fence |
| async integrity | build/switch/recompile/test/package 작업이 status terminal까지 `RUNNING`, lease 조기 해제 0건 |
| multi-agent support | Codex와 Claude Code가 동시에 연결되고 한 client 종료가 다른 client/child에 영향 0건 |
| direct bypass 차단 | unmanaged `unity mcp`, legacy adapter, duplicate broker/editor, seat overflow 0건 |
| recoverable deployment | immutable versioned install, exact build/config verification, backup, previous rollback이 실제로 성공 |
| live proof | 5개 project sequential canary 통과 후 60분 soak 동안 misroute, 중복 mutation, protocol 오염, secret 노출 0건 |

## 바꿀 수 없는 운영 전제

1. Unity CLI `1.0.0-beta.3` 이상이 아니면 gate는 닫혀 있다. 2026-08-03 이 Mac의 exact install channel에서 `unity upgrade --check`는 beta.3을 제시했고 `unity upgrade --changelog`는 재컴파일 뒤 MCP 영구 단절과 실패 eval 오보고 수정을 명시했다. 공개 CLI 문서는 experimental임을 명시하므로 live 승격 때 candidate changelog를 다시 보존한다. [Unity CLI 사용·업데이트](https://docs.unity.com/en-us/unity-cli/use-unity-cli)
2. project 선택은 절대 `--project-path`다. cwd 추측과 제거된 `--instance`에 의존하지 않는다. [Unity CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference)
3. 기본 license capacity는 Editor 1개다. 2 Editor 시험은 floating entitlement와 실제 seat가 확인된 경우에만 별도 gate로 연다. [Unity Editor Software Terms](https://unity.com/legal/editor-terms-of-service/software), [Unity Licensing Server](https://docs.unity.com/licensing/en-us/manual)
4. MCP cancellation은 rollback이 아니다. dispatch 뒤 취소/timeout/connection loss를 실패로 단정하거나 같은 mutation을 재전송하지 않는다. [MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
5. Editor와 broker가 안정적이어도 두 agent가 동시에 같은 source tree를 수정하는 것은 안전하지 않다. 분석과 safe read는 병렬화하고, Unity source/assets/packages write와 source refresh는 workspace guard로 직렬화한다.

## Phase 0 — baseline과 차단 gate

목표: live state를 바꾸기 전에 현재 machine과 checkout을 증거로 고정한다.

1. 다음 결과를 보존한다.

   ```sh
   /Users/zamgune/.unity/bin/unity --version
   /Users/zamgune/.unity/bin/unity mcp --help
   git -C /Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer status --short
   git -C /Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer diff -- Tools/unity-mcp-router
   ```

2. `unity --version`이 beta.3 미만이면 여기서 중단한다. `unity upgrade --check`, `unity upgrade --changelog`, `unity upgrade --dry-run`을 evidence에 기록하고, 별도 승인 후 공식 self-update 경로로 exact candidate를 설치한다.
3. Unity account auth 상태와 license entitlement는 별도로 확인한다. login session과 Editor-local Pipeline token을 하나의 token으로 취급하거나 config/log에 복사하지 않는다.
4. `license.mode=single-seat`, `maxConcurrentEditors=1`로 시작한다.
5. 모든 실행 중 MCP 관련 process와 client config를 inventory한다. raw `unity mcp`가 하나라도 실행 중이면 broker activation 전에 정상 종료한다.

통과 조건:

- CLI beta.3 이상.
- source/client config의 pre-change checksum 또는 backup path 확보.
- unmanaged MCP process 0개.
- floating entitlement가 미확인이라면 Editor를 하나만 연 상태.

## Phase 1 — source와 fault test

목표: 실제 Editor를 건드리지 않고 concurrency state machine과 deployment transaction을 검증한다.

```sh
ROUTER_SRC=/Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer/Tools/unity-mcp-router
NODE_BIN=/Volumes/WD_1TB/Dependencies/Node/node-v24.18.0-darwin-arm64/bin/node

"$NODE_BIN" --test "$ROUTER_SRC"/test/unit/*.test.mjs
"$NODE_BIN" --test "$ROUTER_SRC"/test/integration/broker-adapter.test.mjs
"$NODE_BIN" --test "$ROUTER_SRC"/test/installer/*.test.mjs
```

반드시 evidence로 분리할 항목:

- unit: config canonicalization, scheduler fairness/capacity, lease identity/TTL, journal transition, CLI version comparison.
- fake integration: 다중 adapter, cross-project read, same-project serialization, broker/child kill, cancellation, `UNKNOWN_OUTCOME`, durable workspace recovery, tracked async recovery.
- installer: allowlisted immutable release, whole-operation `lockf` guard + O_EXCL owner lock, backup, atomic current/previous switch, rollback compatibility와 5분 budget.

통과 조건: 세 suite 모두 exit 0. timeout, abort 또는 test 미실행은 pass가 아니다.

## Phase 2 — dry-run과 staging transaction

목표: live launchd를 바꾸기 전에 source/config/Node fingerprint와 설치 transaction을 검증한다.

```sh
ROUTER_CONFIG="$ROUTER_SRC/unity-mcp-router.config.json"
NODE_SHA256=$(/usr/bin/shasum -a 256 "$NODE_BIN" | /usr/bin/awk '{print $1}')

/bin/sh "$ROUTER_SRC/scripts/install-router.sh" \
  --source "$ROUTER_SRC" \
  --config "$ROUTER_CONFIG" \
  --node-bin "$NODE_BIN" \
  --node-sha256 "$NODE_SHA256" \
  --dry-run
```

dry-run은 candidate의 release/source/config/Node SHA와 journal format을 출력하고 managed prefix에는 쓰지 않는다.

```sh
STAGE_ROOT=$(/usr/bin/mktemp -d /private/tmp/unity-mcp-router-install.XXXXXX)
/bin/sh "$ROUTER_SRC/scripts/install-router.sh" \
  --source "$ROUTER_SRC" \
  --config "$ROUTER_CONFIG" \
  --node-bin "$NODE_BIN" \
  --node-sha256 "$NODE_SHA256" \
  --prefix "$STAGE_ROOT/router" \
  --launch-agents-dir "$STAGE_ROOT/LaunchAgents" \
  --staging
```

staging은 `/private/tmp` 안에서 release/config/deployment, wrappers, current/previous link와 backup transaction을 실제로 수행하지만 launchd 또는 live broker에는 접촉하지 않는다.

통과 조건:

- dry-run과 staging의 release/source/config/Node SHA가 의도한 candidate와 일치.
- `journalFormat`이 installer가 요구하는 `2`.
- source allowlist 밖 파일은 release에서 제외되고, allowlisted file 누락/symlink, symlinked config, checksum이 바뀐 Node는 거부됨.
- staging rollback fixture 통과.
- 입력 Node는 symlink/hardlink가 아니고 caller SHA와 일치하며, 복사본의 `process.execPath`가 복사 위치와 정확히 일치한다. macOS dependency audit는 `/usr/lib`와 `/System/Library`만 허용한다.
- staging deployment의 `identity.nodeBin`은 외장 입력 경로가 아니라 `<prefix>/runtimes/<sha256>/node`이고, runtime directory/node는 각각 `0500`, node link count는 1, file set은 `node` 하나다.

## Phase 3 — versioned live activation

목표: launchd가 유일한 broker owner가 되고 exact candidate가 떠 있음을 입증한다.

live installer는 다음 순서로 움직인다.

1. source runtime allowlist와 pinned Node를 SHA-256으로 검증하고 private snapshot에서 version/platform/arch/relocatability를 확인한다.
2. normalized config를 `brokerMode=connect-only`로 고정하고 canonical path, alias, `dev/inode`를 immutable `canonical-devino-v1` prepared config에 기록한다. 설치된 runtime의 config load는 프로젝트 filesystem을 다시 조회하지 않는다.
3. 검증한 Node를 `~/.unity-mcp-router/runtimes/<sha256>/node`에 content-addressed local runtime으로 원자 배치한 뒤, `releases`, `configs`, `deployments` 아래 immutable candidate를 만든다. LaunchAgent는 외장 볼륨 Node를 직접 실행하지 않는다.
4. source config, 기존 LaunchAgent, 명시한 client config, current/previous link를 `backups/<transaction>`에 보존한다.
5. unmanaged Unity MCP/router process를 audit한다.
6. 기존 managed broker가 있으면 status audit 후 drain한다. drain은 queue, 모든 lease와 response `deliveryPending`이 없어야 성공한다.
7. current/previous를 atomic rename으로 전환하고 stable wrappers와 LaunchAgent를 설치한다.
8. `launchctl bootstrap`과 `kickstart` 뒤 version, build SHA, config fingerprint, exact managed Node executable, Unity CLI support와 process audit를 검증한다. 이어 candidate LaunchAgent 문맥에서 5개 project의 `Assets`/`ProjectSettings`와 exact `dev/inode`를 최대 3초씩 병렬 검사하고, doctor 전후 LaunchAgent PID가 동일한지 다시 확인한다.
9. 어느 단계든 실패하면 prior file state를 자동 복구하고 기존 launchd job을 되살린다.

installer와 stable rollback wrapper는 `run/install-lock-cas.guard`의 동일한 file descriptor를 `/usr/bin/lockf`로 잡고 전체 operation이 끝날 때까지 유지한다. 그 안에서 O_EXCL owner lock을 생성·검증·해제하므로 서로 다른 installer/rollback이 assert와 rename 사이에 끼어들 수 없다. guard 대기는 5초로 제한하며, 점유 중이면 새 operation은 fail-closed한다.

owner lock은 PID 생존과 고정 locale·UTC·wide `ps` identity를 함께 확인한다. process observer가 실패하면 `unknown`으로 fail-closed하며 stale로 회수하지 않는다. 새 writer는 lock format v2를 사용하고 새 helper는 legacy v1과 v2를 모두 읽는다. raw v1 helper는 v2를 해석하거나 회수하지 않고 corrupt/unsupported로 fail-closed하므로, 구 wrapper의 locale/timezone이 달라도 live migration lock을 뺏을 수 없다. 반대로 legacy v1은 textual identity가 다르거나 PID가 이미 사라져도 새 helper가 자동 회수하지 않는다. unpatched raw helper가 guard 밖에서 이미 읽은 v1 파일과 경합할 가능성을 배제할 수 없기 때문이다. legacy v1 evidence는 명시적인 offline recovery만 허용한다. lock script identity는 source tree가 아니라 private `0500` snapshot을 가리킨다.

명령은 [README의 live install](../README.md#검증과-설치)을 사용한다. 설치 출력의 `current`, `previous`, `backup`, `adapter`, `launch_agent`를 rollout evidence에 기록한다.

설치 직후:

```sh
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin status --timeout-sec 10
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin doctor --timeout-sec 10
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin drain --timeout-sec 60
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin resume --timeout-sec 10
```

통과 조건:

- LaunchAgent `com.zamgune.unity-mcp-router` 1개와 broker PID 1개.
- status의 broker version/buildId/configHash가 installer candidate와 정확히 일치.
- `unity.supported=true`, `processAudit.ok=true`, `projectAccess.ok=true`이고 doctor의 `responsibleExecutable`이 deployment `identity.nodeBin`과 정확히 일치.
- drain/resume round trip 성공, 종료 시 `draining=false`.
- client adapter를 아직 migration하지 않아도 raw direct process는 0개.

upgrade/rollback 중 이미 떠 있던 adapter는 broker와 build ID가 다르면 attach가 거부된다. stable wrapper 경로는 유지되지만, Codex와 Claude의 기존 MCP session은 재시작해 새 adapter build로 다시 연결해야 한다. build mismatch를 임시 호환으로 우회하지 않는다.

## Phase 4 — Codex/Claude 설정과 5-project sequential canary

목표: 문제가 생긴 project만 되돌릴 수 있도록 한 번에 하나의 project-local default를 migration한다.

순서는 다음으로 고정한다.

1. `UnityCodeMCPServer`
2. `SheepWolf`
3. `SlashNClaim`
4. `DigitalPet`
5. `OhMyFarm`

각 단계에서 다음 절차를 반복한다.

1. 해당 project의 dirty state를 다시 기록한다. 다른 project의 client config는 아직 바꾸지 않는다.
2. single-seat에서는 이전 canary Editor를 닫고 완전히 종료된 것을 확인한 뒤 대상 Editor 하나만 연다.
3. Codex `.codex/config.toml`과 Claude Code local MCP를 stable adapter + 해당 `--default` alias로 바꾼다. raw/legacy server를 동시에 켜지 않는다.
4. doctor와 smoke를 실행한다.

   ```sh
   ROUTER_HOME=/Users/zamgune/.unity-mcp-router
   NODE_BIN=$(/usr/bin/sed -n '1p' "$ROUTER_HOME/current/node-bin.txt")
   RELEASE_ID=$(/usr/bin/sed -n '1p' "$ROUTER_HOME/current/release-id.txt")
   ROUTER_CLI="$ROUTER_HOME/releases/$RELEASE_ID/router-cli.mjs"
   ROUTER_CONFIG="$ROUTER_HOME/current/config.json"

   /Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin status --timeout-sec 10
   "$NODE_BIN" "$ROUTER_CLI" --config "$ROUTER_CONFIG" --broker-mode connect-only \
     --project PROJECT_ALIAS smoke --json
   ```

5. Codex와 Claude에서 동시에 `editor_status` safe read를 호출한다. 결과가 현재 canary project와 Editor를 가리키는지 확인한다.
6. 한 client adapter를 정상 종료하고 다시 연결한다. 다른 client session과 project child가 계속 동작해야 한다. 동기 mutation canary에서는 응답 전달 ACK가 끝난 뒤 `deliveryPending`이 0인지도 확인한다.
7. 해당 project에서 `recompile`을 한 번 실행하고 `recompile_status`가 terminal (`completed` 또는 `up_to_date`)이 될 때까지 확인한다. domain reload 뒤 tool list가 복구되고 필요한 client에만 list-changed가 전달돼야 한다.
8. 별도의 clean/disposable 상태에서만 mutation cancellation/fault canary를 한다. dispatch 뒤 중복 marker가 0이고, 결과 미확정 시 정확히 하나의 `UNKNOWN_OUTCOME`와 project fence가 생기는지 확인한다. 운영 checkout이 dirty하면 이 단계는 fake integration evidence로 대체하고 이유를 기록한다.
9. canary 종료 시 queue, lease, workspace lease, background operation, unknown outcome가 모두 비어 있고 `processAudit.ok=true`인지 확인한다.
10. 해당 project의 Codex와 Claude를 둘 다 통과시킨 뒤에만 다음 project로 이동한다.

project별 통과 기록:

| project | Codex | Claude | simultaneous read | adapter reconnect | recompile recovery | queues/leases clean | audit | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UnityCodeMCPServer |  |  |  |  |  |  |  |  |
| SheepWolf |  |  |  |  |  |  |  |  |
| SlashNClaim |  |  |  |  |  |  |  |  |
| DigitalPet |  |  |  |  |  |  |  |  |
| OhMyFarm |  |  |  |  |  |  |  |  |

한 project가 실패하면 다음 project 설정을 바꾸지 않는다. 해당 client config를 backup에서 복원하고, broker 자체 문제면 Phase 7 rollback으로 간다.

## Phase 5 — 60분 multi-agent soak

목표: 5개 canary를 통과한 동일 build/config에서 장시간 lifecycle, queue, reconnect와 reload를 검증한다.

single-seat 기본 soak는 Editor 하나 + Codex/Claude 동시 연결로 수행한다. “여러 agent”는 여러 Editor를 의미하지 않는다.

Phase 5는 source tree에는 존재하지만 installed deployment runtime allowlist에서는 제외되는 `scripts/live-soak.mjs` 증거 harness를 사용한다. 시작 전 대상 Editor 외 모든 Unity Editor와 별도 MCP adapter session을 정상 종료한다. harness가 만든 Codex-like/Claude-like persistent adapter 정확히 2개만 broker에 연결돼야 하며, soak 중 source/asset/package write와 commit/checkout을 하지 않는다. harness는 Git tracked diff와 non-ignored untracked file byte를 시작/종료 때 fingerprint하고 조금이라도 달라지면 fail-closed한다.

첫 baseline `unity_router_status`에서 선택한 대상 child는 정확히 `READY`여야 하고, 그 외 모든 configured project child는 `OFFLINE`이어야 한다. harness는 이 precondition을 doctor, `editor_status`, reload/restart/fairness mutation보다 먼저 검사한다. 비대상 child가 `READY`, `BUSY`, `STARTING`이거나 PID를 보유하면 즉시 `NON_TARGET_CHILD_ACTIVE_AT_BASELINE`으로 실패한다. 이는 soak 도중 상태 변화에 대한 기존 strict drift 검사를 완화하는 조건이 아니다.

이 오류가 나오면 admin `status`의 `projects[].child`에서 비대상 alias, state, PID를 확인하고 해당 project를 사용하던 stale Codex/Claude adapter session을 정상 종료한다. 모든 비대상 child가 `OFFLINE`임을 확인한 뒤 새 evidence 경로로 다시 시작한다. `childIdleMin=15`의 idle reap이 soak 도중 정리해 줄 것이라고 가정하면 약 15분 지점에 `PROJECT_CHILD_STATE_DRIFT`가 발생하므로 통과로 인정하지 않는다. 반대로 대상 child가 정확히 `READY`가 아니면 `TARGET_CHILD_NOT_READY_AT_BASELINE`이며, 대상 Editor/adapter/catalog readiness를 복구하기 전에는 실행하지 않는다.

먼저 새 evidence 경로로 dry-run한다. evidence 대상은 아직 존재하지 않아야 하며 symlink도 허용하지 않는다.

```sh
ROUTER_SRC=/Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer/Tools/unity-mcp-router
ROUTER_HOME=/Users/zamgune/.unity-mcp-router
NODE_BIN=$(/usr/bin/sed -n '1p' "$ROUTER_HOME/current/node-bin.txt")
PROJECT_ALIAS=UnityCodeMCPServer
PROJECT_PATH=/Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer
SOAK_EVIDENCE=/private/tmp/unity-mcp-router-UnityCodeMCPServer-60m.jsonl

"$NODE_BIN" "$ROUTER_SRC/scripts/live-soak.mjs" \
  --project "$PROJECT_ALIAS" \
  --project-path "$PROJECT_PATH" \
  --evidence "$SOAK_EVIDENCE" \
  --with-reload \
  --with-restart \
  --fairness-burst 6 \
  --dry-run
```

dry-run 출력에서 `durationSec=3600`, `reload=1`, `controlledChildRestart=1`, `fairnessNoopRecompile=6`, `mutationRetries=0`, `sourceWrites=0`, `maximumPeriodicDispatchDriftSec=30`과 canonical project/fingerprint를 검토한다. dry-run은 adapter 연결, evidence 생성, Unity mutation을 전혀 하지 않는다. 검토 뒤 동일 인자에서 `--dry-run`만 제거해 실행한다.

```sh
"$NODE_BIN" "$ROUTER_SRC/scripts/live-soak.mjs" \
  --project "$PROJECT_ALIAS" \
  --project-path "$PROJECT_PATH" \
  --evidence "$SOAK_EVIDENCE" \
  --with-reload \
  --with-restart \
  --fairness-burst 6
```

`--with-reload`, `--with-restart`, `--fairness-burst`는 각각 독립적인 mutation opt-in이다. 어떤 flag도 생략하지 않은 위 명령이 Phase 5 전체 lifecycle gate다. 단순 무변경 관찰만 필요하면 flag를 생략할 수 있지만, 그 결과를 전체 Phase 5 통과로 승격하지 않는다. `--with-restart`는 admin token을 사용하는 source-tree harness 전용이며 installed stable admin wrapper는 project-child restart를 의도적으로 거부한다. reload는 15분에 정확히 1회, Claude-like adapter 정상 종료/재연결은 20분에 1회, project child restart는 30분에 정확히 1회, 양 client에 균등한 no-force `recompile` burst는 40분에 실행된다. mutation timeout이나 연결 손실 뒤 harness는 같은 mutation을 재전송하지 않는다. controlled restart helper는 action deadline에 `TERM`, 1초 뒤 `KILL`을 보내고 최대 3초의 bounded teardown 확인 뒤 반드시 timeout 실패로 닫는다. 이 teardown grace는 작업 성공 시간으로 계산하지 않는다.

notification 계약은 lifecycle별로 다르다. 성공한 source-neutral forced reload는 복구된 catalog가 baseline과 byte-equivalent여도 각 persistent client에 `notifications/tools/list_changed`를 정확히 1회 보내야 한다. 반면 같은 build와 byte-identical catalog를 다시 발견하는 controlled admin restart는 delta가 각 client에서 정확히 0이어야 한다. restart에서 1회라도 발생하거나 reload가 0회/2회 이상이면 `LIST_CHANGED_COUNT_DRIFT`로 실패하며, allowlist와 전체 누계 검사는 계속 적용한다.

evidence는 `O_EXCL|O_NOFOLLOW`로 새 regular file에만 생성되고 mode/owner/link identity를 확인한 뒤 `0600`으로 유지한다. JSONL에는 요약된 identity/count만 기록하며 tool response, notification params, stderr, bearer/JWT/token은 저장하지 않는다. precondition을 통과한 baseline Editor PID/Unity version, broker와 모든 configured project child의 PID/state/catalog fingerprint를 고정하고, controlled restart 때는 선택한 child PID 하나만 바뀌는 것을 허용한다. 60초 read 또는 5분 snapshot이 허용 drift를 넘겨 밀리면 뒤늦게 몰아서 채우지 않고 실패한다. 성공과 실패의 마지막 evidence에는 raw notification 대신 client별 허용 `list_changed` 누계만 `notificationCounts`로 기록한다. 5분 snapshot과 마지막 `final.ok=true`, pre/post dirty fingerprint 일치, `cleanCloseout=true`를 함께 보존한다. 실패 evidence의 mutation dispatch count와 broker journal/status를 확인하기 전 같은 flag run을 다시 시작하지 않는다.

Harness는 raw payload를 evidence에 수집하지 않으므로 `final.ok=true`만으로 broker 원본 log/journal의 secret 부재까지 증명하지는 않는다. 마지막 표의 log/journal 검사는 별도 read-only 검사 결과로 보존하며, 원문을 soak JSONL에 복사하지 않는다.

| 시간 | 작업 |
| --- | --- |
| 0분 | 첫 status에서 target `READY`/모든 non-target `OFFLINE` precondition, 이후 doctor snapshot과 queue/lease/journal baseline |
| 0–15분 | Codex/Claude-like adapter가 60초 간격 동시 `editor_status`; source write는 전 구간 금지 |
| 15분 | `recompile` trigger 후 `recompile_status` terminal, tool list와 client별 `list_changed` delta=1 확인 |
| 20–30분 | adapter 한쪽 종료/재연결, 반대 client 연속 read 확인 |
| 30분 | controlled `unity_router_restart`로 해당 project child만 lazy reconnect; broker 유지, byte-identical catalog의 client별 `list_changed` delta=0 확인 |
| 30–50분 | 양 client의 균등한 source-neutral no-force `recompile` burst와 safe read를 섞고 global heavy가 1을 넘지 않는지 관찰 |
| 50–60분 | idle/reauth/reconnect 관찰, 마지막 status/doctor와 journal/log 검사 |

5분 간격 snapshot에 다음을 기록한다.

- broker PID/buildId/configHash/draining.
- client 수와 각 project child PID/state.
- `pendingTotal`, `activeHeavy`, per-project active/queued.
- active leases, workspace leases, background operation, recovery faults, unknown outcomes.
- `processAudit.ok`, Editor count와 project path.
- Codex/Claude 응답의 expected project identity.
- tool catalog fingerprint와 허용된 `notifications/tools/list_changed` 누계.
- 시작/종료 Git dirty fingerprint와 mutation dispatch/retry 수.

60분 통과 조건:

- broker 재생성/duplicate PID 0건.
- wrong-project response 0건.
- automatic mutation replay와 duplicate side effect 0건.
- 예상하지 않은 `UNKNOWN_OUTCOME`, unresolved workspace lease, recovery fault 0건.
- terminal async 뒤 retained lease 0건.
- protocol stdout contamination/framing error 0건.
- log와 journal의 bearer/JWT/raw eval payload 노출 0건.
- 다른 client 종료로 남은 client 또는 shared child가 중단된 사건 0건.

## Phase 6 — 선택적 2-Editor 60분 soak

이 phase는 기능 toggle이 아니라 license gate다. 구매한 floating entitlement, license server/pool과 동시에 빌릴 수 있는 seat 2개가 확인되지 않으면 실행하지 않고 “license-blocked”로 기록한다. single-seat config의 숫자를 임의로 바꾸는 것은 통과가 아니다.

entitlement 확인 뒤에만 candidate config를 다음처럼 새 versioned deployment로 설치한다.

```json
"license": {
  "mode": "floating",
  "maxConcurrentEditors": 2
}
```

두 Editor는 서로 다른 canonical project를 열어야 한다. 동일 project 중복 Editor는 floating seat가 있어도 금지된다. 60분 동안 다음을 검증한다.

- Codex와 Claude가 각각 다른 default project에 연결해 simultaneous safe read를 수행한다.
- safe read는 cross-project로 겹칠 수 있지만 source-refresh workspace guard는 한 agent만 소유한다.
- heavy 작업은 기본 `maxHeavyInFlight=1`이므로 두 프로젝트 사이에서도 직렬화된다.
- 두 project의 child/tool registry/list-changed/operation journal이 섞이지 않는다.
- Editor 하나를 닫고 다시 열어도 나머지 Editor/client는 유지되고 canonical route가 바뀌지 않는다.
- 전체 Editor count가 config와 실제 entitlement를 넘지 않는다.

통과 조건은 Phase 5의 60분 조건에 “두 Editor PID와 서로 다른 canonical project path가 전 구간 정확히 유지”를 추가한다.

## queue, lease와 workspace 운영 규칙

기본 config의 제한은 다음 의도를 가진다.

- per-client outstanding 32, per-project 128, machine total 512.
- project scheduler는 active operation 하나이며 client별 round-robin fairness를 사용한다.
- 동기 mutation은 Unity 응답 뒤에도 adapter가 응답 전달을 ACK할 때까지 `DELIVERING` 상태와 project fence를 유지한다. 다음 same-project mutation은 ACK보다 앞설 수 없다.
- 비동기 작업의 terminal status를 다른 agent가 먼저 관찰해도 trigger 응답의 ACK/LOST 결정 전에는 tracker와 heavy/source-refresh/exclusive lease를 최대 ACK timeout까지 유지한다.
- heavy/exclusive/tracked-async/unknown tool은 machine-wide heavy budget 1을 사용한다.
- heavy는 source-refresh lease도 필요하다. build/switch는 exclusive-editor lease도 가진다.
- 명시적 workspace guard가 같은 project owner/session에 있으면 그 작업은 기존 source-refresh lease를 사용한다.
- lease TTL 만료는 capacity를 다른 agent에 자동 양도하지 않는다. `orphaned`로 남아 fail-closed 한다.
- workspace lease는 durable file에 기록돼 broker restart 뒤 복구된다. 같은 client/session만 heartbeat/end할 수 있다.

작업 시작 전:

1. source/asset/package write 여부를 분류한다.
2. write라면 workspace guard를 먼저 잡는다. `unity_router_workspace_begin`은 대기 전과 grant 직후 강제 process audit를 하며, heartbeat도 재감사한다. 어느 단계에서든 audit가 실패하면 lease 없이 쓰기를 시작하거나 기존 write를 계속하지 않는다.
3. Editor가 import/compile 중이면 Unity mutation을 시작하지 않는다.
4. tracked async trigger가 `RUNNING`이면 status tool 외 새 mutation을 보내지 않는다.
5. broker가 `RUNNING` operation을 restart 후 복구했거나 추적 중 trigger adapter가 끊겼다면 terminal 뒤 `UNKNOWN_OUTCOME`가 되는 것이 정상 fail-closed 동작이다. 실제 terminal 결과를 확인해 resolve한다.

작업 종료 전:

1. tracked async가 terminal인지 확인한다.
2. Editor import/compile이 멈췄는지 확인한다.
3. workspace lease를 정상 end한다.
4. status에서 queue/lease/fence가 예상대로 비었는지 확인한다.

## 장애 대응

### `CLI_VERSION_UNSUPPORTED`

- `unity --version`과 installed binary path를 확인한다.
- beta.3 이상으로 올리기 전 mutation이나 live rollout을 재시도하지 않는다.
- upgrade 뒤 exact version, 내장 candidate changelog, `unity mcp --help`, recompile smoke를 다시 기록한다.

### `SYSTEM_CONCURRENCY_UNSAFE` 또는 doctor failure

- finding의 PID/kind/project path를 먼저 확인한다.
- raw `unity mcp`, source-tree/legacy adapter, duplicate broker를 정상 종료하고 해당 client config를 stable adapter로 바꾼다.
- 동일 project Editor가 둘이면 하나를 닫는다.
- `unconfigured_editor` 또는 `editor_project_unknown`이면 Editor를 닫고 config에 기록된 exact canonical path로 다시 연다. symlink 표기는 floating 2-seat에서도 허용하지 않는다.
- seat overflow면 entitlement를 확인하기 전 Editor 수를 줄인다.
- `processAuditEnforcement=report-only`로 우회해 운영하지 않는다.

### `PROJECT_ACCESS_DENIED`, `PROJECT_ACCESS_PROBE_TIMEOUT`, `PROJECT_VOLUME_UNAVAILABLE`, `PROJECT_IDENTITY_MISMATCH`

- status/doctor의 `responsibleExecutable`을 확인한다. 승인 대상은 Unity CLI나 Terminal이 아니라 현재 deployment의 exact managed Node다.
- `/Volumes/...` timeout은 TCC 거부로 확정할 수 없으므로 먼저 볼륨 mount/응답성을 확인한다. 그 다음 macOS `시스템 설정 > 개인정보 보호 및 보안 > 파일 및 폴더`에서 해당 Node의 이동식 볼륨 접근을 허용한다.
- Node SHA 또는 managed runtime 경로가 바뀌면 기존 승인을 재사용한다고 가정하지 않는다. 새 경로를 승인한 뒤 `unity-mcp-router-admin doctor --timeout-sec 10`을 다시 실행한다.
- `PROJECT_IDENTITY_MISMATCH`이면 경로가 존재한다는 이유로 승인하지 않는다. 현재 mount와 checkout이 의도한 대상인지 확인한 뒤 source config에서 installer를 다시 실행해 새 immutable identity를 만들어야 한다.
- access gate 실패 전에는 Unity child나 mutation이 dispatch되지 않는다. 같은 mutation을 수동 재전송하기 전에 status에서 `UNKNOWN_OUTCOME`가 없음을 확인한다.
- timeout을 60초 이상으로 늘리는 것은 해결책이 아니다. 3초 helper가 종료되지 않으면 broker는 helper만 `SIGKILL`하고 fail-fast한다.

### `TOOL_CATALOG_RECOVERING` 또는 `INVALID_TOOL_CATALOG`

- 성공한 recompile 직후의 짧은 `TOOL_CATALOG_RECOVERING`은 Pipeline server가 domain reload 뒤 다시 올라오는 동안의 fail-closed 상태다. 같은 recompile mutation을 다시 보내지 말고, 기존 canary deadline 안에서 `tools/list` 복구를 기다린다.
- broker는 이전 non-empty catalog를 stale 상태로 반환하거나 transient empty fingerprint로 덮어쓰지 않는다. 복구 뒤 catalog는 reload 전과 byte-equivalent여야 하고 같은 project client의 `list_changed`는 각각 정확히 1회여야 한다.
- `INVALID_TOOL_CATALOG` 또는 10초를 넘는 recovery가 반복되면 새 mutation을 중단한다. Unity Console과 Pipeline HTTP server 재시작 로그, `unity_router_status`의 child/queue 상태를 확인하고 원인 확인 전 broker/Editor를 연속 재시작하지 않는다.

### `UNKNOWN_OUTCOME`

1. 같은 mutation을 다시 보내지 않는다.
2. operation id를 기록하고 조회한다.

   ```sh
   /Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin \
     operation status OPERATION_UUID
   ```

3. project filesystem, Unity Console, Editor/Pipeline status와 실제 side effect를 독립 확인한다.
4. 완료가 확인된 경우에만 stable wrapper로 resolve한다. 완료를 입증할 수 없으면 fence를 유지하고 추가 조사한다.

   ```sh
   /Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin \
     operation resolve OPERATION_UUID confirmed_completed
   ```

5. `RUNNING` record를 수동 resolve해야 한다면 status가 terminal이고 실제 process가 끝났음을 확인한 뒤, resolution 바로 다음의 정확한 위치에 `--confirm-no-longer-running`을 추가한다.

   ```sh
   /Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-admin \
     operation resolve OPERATION_UUID confirmed_completed --confirm-no-longer-running
   ```

6. fence 해제 후에도 재실행은 새로운 명시적 operation이다. 자동 replay는 없다.

`RESULT_DELIVERY_UNCERTAIN` 또는 response ACK timeout은 Unity 실행 실패를 뜻하지 않는다. Unity side effect가 성공했지만 client가 결과를 받지 못했을 수 있으므로 일반 timeout처럼 같은 mutation을 다시 보내면 안 된다.

### workspace heartbeat/end 실패

- guarded command는 즉시 write를 중단한다.
- `workspaceLeases`와 `workspace-leases.json`, tracked async 상태를 확인한다.
- async가 `RUNNING`이면 lease를 강제로 풀지 말고 status terminal까지 기다린다.
- orphan임과 Editor import/compile idle을 독립 검증한 뒤에만 다음 admin command를 사용한다.

  ```sh
  "$NODE_BIN" "$ROUTER_CLI" --config "$ROUTER_CONFIG" --broker-mode connect-only \
    workspace resolve LEASE_TOKEN --confirm
  ```

### drain 실패

- drain은 pending queue뿐 아니라 모든 active/orphaned/workspace/async lease와 `deliveryPending`이 0이어야 성공한다.
- `status`에서 남은 operation/lease owner를 해결한다.
- maintenance를 취소하면 반드시 `resume`; broker가 drained 상태인지 추측하지 않는다.
- lease나 operation을 강제로 없애려고 journal/state file을 직접 편집하지 않는다.

## Phase 7 — rollback

관리된 previous deployment가 있을 때 stable wrapper를 사용한다.

```sh
/Users/zamgune/.unity-mcp-router/bin/unity-mcp-router-rollback \
  --drain-timeout-sec 60 \
  --verify-timeout-sec 30
```

rollback은 다음을 검증한다.

- whole-operation `lockf` guard와 O_EXCL owner lock.
- current와 previous deployment/release SHA.
- pinned Node path와 SHA.
- journal/workspace path compatibility.
- v2 non-terminal operation 또는 durable workspace lease를 구버전이 오해하지 않는지.
- `launchctl print` exit 113만 정확한 미등록으로 인정하고 다른 조회 실패는 `unknown`으로 닫는지. `bootout` 직전에 관찰한 현재 등록 PID와 transaction의 원래 PID가 모두 ESRCH이고 job도 미등록인 상태를 최대 10초 기다린 뒤에만 link/plist를 전환하는지. 정상 rollback과 transaction 복구에 같은 bounded wait를 적용한다.
- 현재 broker drain, launchd switch, target exact version/build/process audit/project access doctor.
- 전체 5분 미만.
- managed runtime deployment와 legacy external-Node v1 deployment의 실제 control-plane 양방향 호환.

첫 install처럼 `previous`가 없으면 rollback wrapper를 쓸 수 없다. activation 중 실패는 installer가 자동으로 prior file/job state를 복구한다. rollback 실패 시 출력된 backup directory를 보존하고 수동 삭제/덮어쓰기를 하지 않는다.

`canonical-devino-v1` identity doctor 도입 전 immutable deployment는 `doctor`가 없거나 path-only access 결과만 제공한다. 첫 업그레이드 실패의 자동 복구와 그 legacy target으로의 첫 rollback만 기존 exact status/process audit로 복구를 확인하고 status-only 경고를 남긴다. 새 identity doctor를 포함한 deployment끼리의 install/rollback은 project access 검사를 생략할 수 없다. legacy deployment를 수정해서 명령을 덧붙이지 않는다.

첫 managed-runtime migration에서는 `managed current → legacy previous → managed current` 왕복을 실제로 수행하고 각 방향에서 exact deployment/PID/build/config를 확인한다. 첫 방향은 managed stable rollback wrapper를 사용한다. legacy가 `current`가 된 뒤 stable wrapper를 다시 호출하면 legacy control plane으로 dispatch되므로, 복귀는 같은 frozen source/config/Node SHA의 새 installer를 재실행하는 roll-forward로 수행한다. 이 drill이 끝날 때까지 legacy deployment가 가리키는 외부 Node를 이동·교체·삭제하지 않는다. managed deployment가 최종 `current`가 된 뒤에도 rollback evidence와 backup은 rollout 종료까지 보존한다.

raw v1이 `current`인 동안 새 installer/managed rollback이 SIGKILL로 중단돼 v2 lock이 남으면 raw v1 rollback으로 그 lock을 강제 회수하지 않는다. 같은 pinned source의 새 installer를 다시 실행해 PID/start identity, transaction marker와 lock digest를 검증하고 stale evidence로 보존한 뒤 복구한다. lock 파일을 수동 삭제하면 안 된다.

legacy v1 `install.lock`은 owner PID가 죽었더라도 자동 stale 회수 대상이 아니다. offline recovery가 필요하면 먼저 모든 legacy install/rollback 실행이 끝났고 관련 process가 0개임을 별도 audit로 입증한다. 그 다음 원본 bytes와 SHA-256을 보존하고, guard를 독점한 단일 operator 절차로 같은 `run` 디렉터리의 고유 evidence 이름에 이동한 후 새 installer를 다시 실행한다. 이 세 조건을 충족하지 못하면 lock을 삭제·덮어쓰기·이동하지 않는다.

rollback 뒤에도 project client config는 installer가 자동 변경하지 않는다. stable wrapper path는 유지되므로 보통 deployment만 바뀌지만, client config 자체를 되돌려야 할 때는 install output의 `backup` 아래 `client-configs.tsv`와 checksum을 확인해 exact file만 복원한다.

## 검증 계층과 증거 규칙

| 계층 | 증거 | 증명하지 못하는 것 |
| --- | --- | --- |
| static/config | syntax, config normalization, SHA, unit test | 실제 process/Editor 연결 |
| fake concurrency | socket, queue, lease, crash/cancel integration | Unity package/Editor 동작 |
| deployment | staging/live transaction, launchd PID, exact build/config | Game View나 실제 domain reload |
| MCP live | Codex/Claude initialize, tools/list, editor_status | gameplay/device 결과 |
| Unity live | recompile/status, test/build/package terminal polling | Android/iOS/device 실행 |
| platform/device | build artifact, install/run, device log | 다른 project의 안정성 |
| soak/manual | 60분 metrics, no misroute/duplicate/secret | 수행하지 않은 fault case |

각 보고에는 `pass`, `fail`, `blocked`, `not run`을 구분한다. Editor unavailable, timeout, aborted test와 license 미확인은 pass가 아니다.

## dirty worktree와 allowlist

이 router rollout은 기존 사용자의 수정과 다른 project 작업을 정리할 권한을 주지 않는다.

- 시작과 live 적용 직전에 source repository의 `git status --short`와 relevant diff를 다시 비교한다.
- status 경로 목록 해시만으로는 같은 dirty 파일 안의 내용 손실을 잡을 수 없다. 각 repository마다 HEAD/branch, porcelain status SHA-256, `HEAD → index` binary diff SHA-256, `index → worktree` binary diff SHA-256, 그리고 모든 non-ignored untracked 파일의 path/mode/content SHA-256 manifest를 함께 기록한다.
- canary 뒤 위 content fingerprint를 다시 계산한다. 사전에 승인한 client config처럼 의도한 파일을 제외한 차이가 하나라도 있으면 다음 project로 진행하지 않고, 자동 삭제나 reset 없이 diff를 보존해 조사한다.
- user의 기존 `Tools/unity-mcp-router/unity-mcp-router.mjs` 수정은 merge 대상으로 취급하며 파일 전체 덮어쓰기로 없애지 않는다.
- `git reset`, `git clean`, `git stash`, `git checkout --`, force push, `git add -A`를 사용하지 않는다.
- installer는 `scripts/install-router.sh`의 `RUNTIME_FILES` hardcoded allowlist만 package한다. repository 전체, `.DS_Store`, test fixture, unrelated project file을 release에 섞지 않는다.
- source repo에 staging 결과를 적용할 때도 실제 변경된 router file의 명시적 allowlist만 사용하고, 적용 직전에 fingerprint가 달라졌으면 중단해 diff를 다시 합친다.
- client config는 정확한 절대 경로를 하나씩 backup하고 수정한다. parent directory나 home 전체를 복사/덮어쓰지 않는다.
- Unity canary 전에 각 project의 dirty state를 기록하고, canary가 만든 의도하지 않은 `Assets`, `Packages`, `ProjectSettings` 변경은 자동 삭제하지 않는다.

## 공식 근거

- [Use the Unity CLI](https://docs.unity.com/en-us/unity-cli/use-unity-cli)
- [Unity CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference)
- [Unity Pipeline package](https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package)
- [Pipeline connectivity](https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/connectivity.html)
- [Pipeline creating commands](https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/creating-commands.html)
- [Pipeline build, compilation and tests](https://docs.unity3d.com/Packages/com.unity.pipeline@0.4/manual/commands/build-and-compilation.html)
- [Unity Editor Software Terms](https://unity.com/legal/editor-terms-of-service/software)
- [Unity Licensing Server](https://docs.unity.com/licensing/en-us/manual)
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
