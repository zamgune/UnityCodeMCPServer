# unity-mcp-router v2 validation record — 2026-08-03

이 문서는 `2.0.0-dev` source candidate를 이 Mac에 설치하고 실제로 검증한 결과를 보존한다.
설계 설명이나 다음 rollout 절차는 [README](../README.md)와 [OPERATIONS](OPERATIONS.md)를
따른다. 아래 `pass`는 적힌 검증 계층만 증명한다.

## 승인된 운영 범위

- Unity CLI: exact `1.0.0-beta.3`, signed in.
- Pipeline: `0.4.0-exp.1`.
- compatibility package: embedded `0.3.0`, 44-file tree SHA-256
  `31f1e21eb828eb3e36c6f4fe98386a4d2f2163ad759071f89a4df12f73d7595c`.
- license policy: `single-seat`, `maxConcurrentEditors=1`.
- 동시 사용 승인: Unity Editor 1개 + 같은 broker에 연결된 Codex/Claude client 여러 개.
- 미승인 범위: Unity Editor 2개 동시 사용.

두 Editor 시험은 Unity Personal seat 하나로 대체할 수 없다. floating Licensing Server와
가용 seat 2개를 실제로 확인한 뒤 `floating` candidate를 별도 설치하고 독립 60분 soak를
통과해야 한다.

## 설치 identity

| 항목 | 검증 값 |
| --- | --- |
| managed prefix | `/Users/zamgune/.unity-mcp-router` |
| current deployment | `d-59370b98e5e089611ce2b6da903aa719` |
| previous deployment | `d-7580d6e572be6c12af92357275a7048a` |
| source build SHA-256 | `0dea000855f46fdf586c4fbd2dea46ba1bf11ccc5069df7953762e86cfc6eff2` |
| config fingerprint | `71a574e4fde541b94bc06bd1b8683d1d40c818138c101fd52146e77b741c753b` |
| normalized config SHA-256 | `21332a7f6fd8d67ed73b05ace218815add79557513b66c0a08b7851339bd1ece` |
| managed Node SHA-256 | `ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a` |
| LaunchAgent plist SHA-256 | `2c4bd298f25f2c933fdea543cd6bf01958db31397cc5037a9d302062890036d4` |

설치 뒤 broker 1개, unmanaged direct MCP process 0개, project별 official child 최대 1개를
확인했다. 최종 queue, lease, delivery-pending, workspace fence와 unknown outcome는 모두 0이었다.

## 자동 검증

| 계층 | 결과 | 증명 범위 |
| --- | --- | --- |
| router unit/fake | `178/178` pass | config, queue, lease, journal, failure/reload policy |
| router broker/adapter integration | `38/38` pass | shared daemon, cancellation, reload, reconnect, async recovery |
| router installer/rollback | `56/56` pass | immutable install, locks, signals, launchd, rollback/recovery |
| config/process 집중 감사 | `34/34` pass | exact path/process 분류와 bypass detection |
| install-lock identity | `7/7` pass | exact TERM/owner identity와 stale-lock fail-closed |
| 실제 TERM recovery 집중 검사 | `1/1` pass | interrupted transaction recovery |
| compatibility focused suite | `98/98` pass | Pipeline 0.4 status/recompile shim 계약 |
| clean Pipeline EditMode fixture | 622 total, 572 pass, 0 fail, 50 skipped | clean project Editor test surface |
| clean Pipeline PlayMode fixture | 19 total, 2 pass, 0 fail, 17 skipped | clean project PlayMode surface |

Skipped test는 pass로 바꾸지 않았다. 위 clean fixture는 각 게임 프로젝트의 전체 제품 테스트를
대신하지 않는다.

Router 재검증은 source를 `/private/tmp`의 새 사본으로 복사한 뒤 managed Node
`v24.18.0`으로 세 command를 분리 실행했다. 합계는 `272/272`이다. test tree 31파일은
router root 기준 `test/...` relative path, full octal mode (`100644`/`100755`), file SHA-256
hex를 각각 `path NUL mode NUL hash LF` row로 만들고 byte-sort 순서로 결합해 SHA-256
`3280e30ec8d07ae07aa182bf665690405adb6519e024a0c720942f10af163671`로 고정했다.

최종 source 감사에서 built-in mutation class를 `recovery.toolClasses`로 `safe_read`에
약화할 수 있던 config 경로를 발견했다. 최종 source는 built-in class를 immutable로 만들고
config normalization과 policy 생성 양쪽에서 해당 override를 거부한다. 이 회귀 검사가 unit
2건 증가분이다. 현재 설치 deployment의 `toolClasses`는 비어 있어 이 경로가 활성화된 적은
없다. 위 60분 live soak와 설치 identity는 정확히 기존 source build SHA-256
`0dea000855f46fdf586c4fbd2dea46ba1bf11ccc5069df7953762e86cfc6eff2`에 귀속되며, 이
closeout hardening을 설치본에 포함했다고 주장하지 않는다. 다음 runtime 교체는
새 immutable deployment와 canary를 다시 통과해야 한다.

## 5-project sequential canary

모든 프로젝트에서 Codex와 Claude의 local scope가 같은 stable adapter와 정확한 default alias를
사용하는지 확인했다. lifecycle은 `noop -> reload -> noop`, reload 뒤 tool catalog 복구와 필요한
client에만 `list_changed` 1회를 요구했다.

| project | alias | config/transport | lifecycle | focused product evidence |
| --- | --- | --- | --- | --- |
| UnityCodeMCPServer | `UnityCodeMCPServer` | pass | pass | compatibility `98/98` |
| Sheep-Wolf | `SheepWolf` | pass | pass | campaign validator pass; template validator의 기존 UI contract 8건은 별도 잔여 |
| SlashNClaim | `SlashNClaim` | pass | pass | `11/11` pass |
| DigitalPet | `DigitalPet` | pass | pass | `5/5` pass |
| OhMyFarm | `OhMyFarm` | pass | pass | `5/5` pass |

`UnityCodeMCPServer`, `SlashNClaim`, `OhMyFarm`, `SheepWolf`, `DigitalPet`의 Codex 설정은
startup/tool timeout `90/310`을 사용한다. Claude local scope도 같은 adapter/alias를 사용한다.
전역 Codex `unity_pajiready`, `unity_gonggi`는 비활성 상태로 감사했다.

대상 5개 밖의 `CookingServival` Claude local scope에는 raw legacy MCP 설정이 남아 있다. 당시
unmanaged process는 없었지만, 그 프로젝트를 broker inventory에 편입하기 전에는 반드시 해당
설정을 제거하거나 비활성화하고 별도 canary를 수행한다.

## 60-minute soak

`UnityCodeMCPServer` Editor 하나와 Codex-like/Claude-like persistent adapter 두 개로 r5 soak를
60분 수행했다.

- safe-read round 61회, status snapshot 13회.
- adapter reconnect 1회, forced reload 1회, controlled child restart 1회.
- fairness no-op recompile burst 6회.
- mutation retry 0회, cross-project misroute 0회.
- reload `list_changed`는 client별 정확히 1회, restart delta는 0회.
- source dirty fingerprint는 시작/종료가 같았고 graceful closeout을 확인했다.
- 영구 evidence: [unity-mcp-router-UnityCodeMCPServer-60m-r5.jsonl](evidence/unity-mcp-router-UnityCodeMCPServer-60m-r5.jsonl),
  SHA-256 `08cd246d51f893b8092c0026a32e80f067395c5f935a9aa2a498e6b66bc3baf9`,
  `final.ok=true`.

이 결과는 “한 Editor를 여러 agent가 공유”하는 범위다. 두 Editor 동시 실행 결과가 아니다.

## 실제 rollback drill

stable rollback wrapper로 `d-59370...`에서 `d-7580...`으로 전환한 뒤, 동일하게 frozen된
source/config/Node installer를 재실행해 원래 current로 복귀했다.

- rollback 완료: 36초.
- rollback backup: `20260803T115115Z-rollback-44669`.
- roll-forward backup: `20260803T115316Z-48448`.
- 최종 링크: current `d-59370...`, previous `d-7580...`.
- `transaction.json`, `install.lock` 잔존 0개.
- 양 deployment의 exact deployment audit와 5-project access doctor 통과.

Rollback은 client config를 자동 수정하거나 복원하지 않는다. installer에 지정한 config는 backup과
SHA 기록 대상일 뿐이며, client 전환은 별도 allowlist 작업이다. 현재 상태에서 rollback wrapper를
다시 호출하면 방향이 다시 뒤집히므로 incident 판단 없이 반복 호출하지 않는다.

## 알려진 한계와 다음 gate

1. Unity/project 자체의 crash, 게임별 전체 회귀, Android/iOS 기기 동작은 이 broker 기록으로
   보증하지 않는다.
2. 두 Editor 동시 사용은 floating 2-seat 확인과 독립 60분 soak 전까지 blocked다.
3. 같은 source tree에 대한 Codex/Claude write는 여전히 workspace guard로 직렬화해야 한다.
4. CLI, Pipeline, Node, config 또는 runtime allowlist가 바뀌면 새 immutable deployment와 canary가
   필요하다. 설치본을 직접 고치지 않는다.
5. 초기 soak r1-r4의 실패는 최종 r5로 삭제하지 않는다. non-target child baseline, fingerprint race,
   reconnect/restart/list-changed 정책을 수정하게 만든 진단 evidence로 취급한다.
