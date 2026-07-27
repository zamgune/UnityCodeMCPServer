# unity-mcp-router

공식 `unity mcp` 서버 앞에 두는 얇은 **stdio MCP 프록시**.
Codex에 서버 **1개**만 등록하고, 툴 호출 시 `project` 인자로 프로젝트를 전환한다.

## 무엇을 고치는가

`unity mcp`는 이미 stdio MCP 서버다. 그래서 401의 원인은 전송 방식이 아니라 **프로세스 수명**이다.

1. `unity auth login`이 캐시한 Unity Cloud 토큰을 `unity mcp` 프로세스가 시작 시점에 읽어 물고 있는다.
2. 세션이 길어져 토큰이 만료되면 그 프로세스는 계속 `401 Unauthorized`를 뱉는다.
3. Codex를 포함한 MCP 클라이언트는 세션 도중 MCP 서버를 재시작할 수 없다 → "공식 Unity 연결 프로세스가 재생성되지 않음".

라우터가 자식 프로세스를 직접 소유하면서 이 고리를 끊는다.

| 상황 | 라우터 동작 |
| --- | --- |
| 응답에 401 / Unauthorized / token expired | `unity auth status`로 자격증명 갱신 → 자식 재시작 → **같은 인자로 1회 재시도** (클라이언트는 모름) |
| 로그아웃 상태 | 재시도 대신 `unity auth login` 실행하라는 명확한 메시지 반환 |
| Editor 미연결 / ECONNREFUSED / `No Pipeline instance found` | `unity command --project-path`로 프로브 → 재시작 후 재시도, 실패 시 체크리스트 반환 |
| 클라이언트 시작 시 Editor가 닫혀 있었음 | `unity mcp`는 Editor 없이도 뜨고 툴 목록을 **비워서** 준다. 라우터는 그 목록을 캐시하지 않고, 나중에 툴이 생기면 `notifications/tools/list_changed`를 보낸다 |
| 유휴 시간 | 20분마다 `unity auth status`로 토큰을 데우고, 툴 목록이 비어 있으면 다시 조회 |

툴 스키마는 Unity 것을 그대로 통과시킨다. 라우터가 추가하는 건 각 툴의 선택적 `project` 인자뿐이다.

## 설치

Node 18+ 외 의존성 없음.

설정 파일을 복사하고 경로를 확인/수정한다. 실제 config는 머신마다 절대경로가 달라 gitignore 대상이다.

```sh
cp unity-mcp-router.config{.example,}.json
```

```json
{
  "unityBin": "/Users/zamgune/.unity/bin/unity",
  "defaultProject": "UnityCodeMCPServer",
  "projects": [
    { "name": "UnityCodeMCPServer", "path": "/Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer" },
    { "name": "SlashNClaim",        "path": "/Volumes/WD_1TB/ForkDefault/SlashNClaim" },
    { "name": "OhMyFarm",           "path": "/Volumes/WD_1TB/ForkDefault/OhMyFarm" },
    { "name": "SheepWolf",          "path": "/Volumes/WD_1TB/PuzzleGameFoundations/Sheep-Wolf" }
  ]
}
```

> 이름은 툴 인자 enum으로 노출되므로 `&`나 공백 없이 `SheepWolf` 형태를 쓴다.
> Sheep-Wolf는 `ForkDefault`가 아닌 `PuzzleGameFoundations` 아래에 있다.
> `--config`를 생략하면 스크립트 옆의 `unity-mcp-router.config.json`을 자동으로 읽는다.

## Codex 등록

기존에는 프로젝트마다 `.codex/config.toml`이 따로 있었다.

- `SlashNClaim/.codex/config.toml` → `unity_slashnclaim`
- `OhMyFarm/.codex/config.toml` → `unity_ohmyfarm`
- `Sheep-Wolf/.codex/config.toml` → `unity_sheep_wolf`
- `UnityCodeMCPServer/.codex/config.toml` → `unity_codemcp`

이 블록들을 지우거나 `enabled = false`로 두고, 라우터 하나만 등록한다.

```toml
[mcp_servers.unity]
command = "node"
args = [
  "/Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer/Tools/unity-mcp-router/unity-mcp-router.mjs",
  "--default",
  "UnityCodeMCPServer",
]
startup_timeout_sec = 90
tool_timeout_sec = 300
```

프로젝트별 세션에서 기본 대상만 바꾸려면 `--default` 값만 교체한다.

```toml
args = [
  "/Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer/Tools/unity-mcp-router/unity-mcp-router.mjs",
  "--default", "OhMyFarm",
]
```

## Claude Code 등록

한 번만 등록하면 모든 프로젝트 디렉터리에서 쓸 수 있다. 프로젝트 전환은 툴의 `project` 인자로 한다.

```sh
claude mcp add -s user unity -- node /Volumes/WD_1TB/ForkDefault/UnityCodeMCPServer/Tools/unity-mcp-router/unity-mcp-router.mjs --default UnityCodeMCPServer
```

되돌리려면 `claude mcp remove -s user unity`.

## CLI (MCP 클라이언트 없이)

`router-cli.mjs`는 라우터를 일회성으로 띄워 결과만 찍는다. MCP 등록도, 툴 타임아웃도 없어서
셸을 쓸 수 있는 에이전트면 무엇이든 그대로 쓸 수 있다.

```sh
node router-cli.mjs smoke SheepWolf                     # 라우터 + Editor 검증, 실패 시 exit 1
node router-cli.mjs list --project SheepWolf            # 툴 목록
node router-cli.mjs call editor_status --project OhMyFarm
node router-cli.mjs call eval '{"code":"..."}' --project SheepWolf --json
```

`--json`은 가공 없이 원본 result를 출력한다. `--project`를 주면 라우터의 기본 프로젝트까지 같이 바뀌므로
`list`도 해당 프로젝트의 툴을 보여준다.

Editor 없이 돌릴 수 있는 유일한 검사는 실패 분류 테이블이다. 패턴을 고쳤으면 이걸 돌려라.

```sh
node unity-mcp-router.mjs --self-check
```

## 사용

기존 Pipeline 툴(`editor_status`, `eval`, `run_tests`, `capture_game_view`, `zamgune_play_*` …)은 이름과 인자가 그대로다. 다른 프로젝트를 대상으로 하려면 `project`만 추가한다.

```json
{ "name": "editor_status", "arguments": { "project": "OhMyFarm" } }
```

라우터가 추가로 제공하는 툴:

| 툴 | 용도 |
| --- | --- |
| `unity_router_status` | 프로젝트 목록, 각 자식 프로세스 상태·업타임, CLI 버전, 로그인 여부 |
| `unity_router_restart` | 특정 프로젝트의 `unity mcp` 강제 재시작 |
| `unity_auth_refresh` | `unity auth status` 실행 후 재로그인 필요 여부 보고 |

## 동작 조건

- 대상 프로젝트의 Unity Editor가 **열려 있고 컴파일이 끝난 상태**여야 한다. 라우터는 인증을 대신 해주지만 Editor를 대신 띄우지는 않는다.
- 각 프로젝트에 `com.unity.pipeline`이 설치되어 있어야 한다 (`unity pipeline list --project-path <path>`).
- 자식 프로세스는 **지연 생성**된다. 프로젝트 3개를 등록해도 실제로 호출한 프로젝트만 `unity mcp`가 뜬다.

## 로그

`~/.unity-mcp-router/router.log` (JSON Lines). stdout은 JSON-RPC 전용이라 로그가 섞이지 않는다.
복구가 일어나면 `"msg":"recovering from failure"` 항목에 `failure: "auth" | "editor"`가 남는다.

```sh
tail -f ~/.unity-mcp-router/router.log | grep -E 'recovering|child exited|auth status'
```

## 옵션

| 플래그 / 설정 키 | 기본값 | 설명 |
| --- | --- | --- |
| `--config` | 스크립트 옆 `unity-mcp-router.config.json` | 설정 파일 경로 |
| `--unity` / `unityBin` | `unity` | Unity CLI 절대 경로 |
| `--default` / `defaultProject` | 목록 첫 항목 | `project` 인자 생략 시 대상 |
| `--project name=path` | – | 설정 파일 없이 프로젝트 추가 (반복 가능) |
| `--tool-timeout-sec` | `300` | 툴 호출 타임아웃 |
| `--startup-timeout-sec` | `60` | 자식 initialize 타임아웃 |
| `--reauth-interval-min` | `20` | 백그라운드 토큰 갱신 주기 (`0`이면 끔) |
| `--max-retries` | `1` | 복구 후 재시도 횟수 |

환경변수 `UNITY_BIN`, `UNITY_MCP_PROJECTS`(`name=path,name=path`), `UNITY_MCP_DEFAULT`도 지원한다.

## 롤백

라우터를 빼고 싶으면 Codex 설정을 예전 형태로 되돌리면 된다. 라우터는 상태를 저장하지 않는다.

```toml
[mcp_servers.unity_slashnclaim]
command = "/Users/zamgune/.unity/bin/unity"
args = ["mcp", "--project-path", "/Volumes/WD_1TB/ForkDefault/SlashNClaim"]
```
