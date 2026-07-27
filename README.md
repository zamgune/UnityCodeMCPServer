# Unity CLI Pipeline Compatibility

This repository now uses Unity's official CLI, MCP server, and `com.unity.pipeline` package as
the default automation path.

The maintained package is `com.zamgune.unity-pipeline-compat` `0.2.0`. It adds only the two
capabilities that were not equivalent during the migration from UnityCodeMCPServer:

- deterministic, InputAction-name based timed Play Mode steps;
- final-composited Game View capture, including `ScreenSpaceOverlay` UI.

The old `com.signal-loop.unitycodemcpserver` package and Python/uv stdio bridge remain in this
repository at `0.7.0` for rollback only. They are not required by the official path and are not the
default installation.

## Validated baseline

| Component | Version | Role |
| --- | --- | --- |
| Unity Editor | Unity 6.0 or newer | Pipeline host |
| Unity CLI | `1.0.0-beta.2` | CLI and official MCP stdio server |
| `com.unity.pipeline` | `0.3.1-exp.1` | Editor command surface |
| `com.zamgune.unity-pipeline-compat` | `0.2.0` | Timed input and composed capture only |
| Input System | `1.19.0` | Named InputAction injection |
| `Tools/unity-mcp-router` | `1.0.0` | stdio proxy; token refresh and child restart |

The router is a repository tool, not part of the UPM package. Changing it does not require a
`com.zamgune.unity-pipeline-compat` version bump or a manifest update in consuming projects.

Unity CLI is beta and Pipeline is experimental. Pin these versions when reproducing the validated
setup instead of silently accepting a newer release.

Official references:

- [Unity CLI announcement](https://unity.com/blog/meet-the-unity-cli)
- [Unity CLI documentation](https://docs.unity.com/en-us/unity-cli)
- [Unity Pipeline package](https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package)

## Install the official path

### 1. Install and pin Unity CLI

Follow Unity's installation documentation, then verify the binary and pin the validated beta when
that exact environment is required:

```sh
unity --version
unity upgrade --target 1.0.0-beta.2
unity --version
```

The final output must be `1.0.0-beta.2` for the baseline documented here.

### 2. Install Pipeline into the Unity project

Open the project once in Unity 6, authenticate the CLI if needed, and install the exact Pipeline
package:

```sh
unity auth login
unity pipeline install \
  --project-path "/absolute/path/to/UnityProject" \
  --package-version 0.3.1-exp.1
```

### 3. Add the compatibility package

Add this dependency to the project's `Packages/manifest.json` only when deterministic named input
or final-composited Game View capture is needed:

```json
{
  "dependencies": {
    "com.zamgune.unity-pipeline-compat": "https://github.com/zamgune/UnityCodeMCPServer.git?path=/Packages/com.zamgune.unity-pipeline-compat#compat-v0.2.0"
  }
}
```

The package itself pins Pipeline `0.3.1-exp.1` and Input System `1.19.0`. For production projects,
keep the Git tag or replace it with an audited commit SHA; do not depend on a moving branch.

No Python, uv, UniTask, settings asset, copied bridge, or background file watcher is used by this
path.

### 4. Register the MCP server through the router

`unity mcp` is Unity's official MCP server and it already speaks stdio, so transport was never the
weak point. Process lifetime is. The server reads the Unity Cloud token that `unity auth login`
cached and holds it for as long as it runs; once that token expires it returns `401 Unauthorized`
for the rest of its life. MCP clients cannot restart a server mid-session, so the session stays
dead until the user restarts the whole client.

[`Tools/unity-mcp-router`](Tools/unity-mcp-router/README.md) closes that gap. It is a dependency-free
Node stdio proxy that owns the `unity mcp` child process, so it can refresh the credential, restart
the child, and retry the call without the client noticing. It also spawns one child per project, so
a single registered server can drive every Unity project here.

Copy both machine-local files, then register the router:

```sh
cp Tools/unity-mcp-router/unity-mcp-router.config{.example,}.json
cp .codex/config.toml{.example,}
```

Edit the copied config so each project name maps to an absolute path, then:

```toml
[mcp_servers.unity]
command = "node"
args = [
  "/absolute/path/to/UnityCodeMCPServer/Tools/unity-mcp-router/unity-mcp-router.mjs",
  "--default", "UnityCodeMCPServer",
]
startup_timeout_sec = 90
tool_timeout_sec = 300
```

Both copies are gitignored so another machine can use its own absolute paths. Disable any older
per-project `unity mcp` entries in the same file; two MCP processes must never attach to one Editor.

Every tool then accepts an optional `project` argument, and the router adds `unity_router_status`,
`unity_router_restart`, and `unity_auth_refresh` for diagnosing the auth layer.

Claude Code registers the same router once, at user scope, so every project directory sees it:

```sh
claude mcp add -s user unity -- node /absolute/path/to/UnityCodeMCPServer/Tools/unity-mcp-router/unity-mcp-router.mjs --default UnityCodeMCPServer
```

Any agent that can run a shell can skip MCP registration entirely and use the router's one-shot CLI,
which has no client-side tool timeout:

```sh
node Tools/unity-mcp-router/router-cli.mjs smoke SheepWolf
node Tools/unity-mcp-router/router-cli.mjs call editor_status --project OhMyFarm
```

Registering `unity mcp` directly still works and remains the documented fallback — bind it to one
canonical project path so another open Editor is never selected by accident:

```toml
[mcp_servers.unity_my_project]
command = "/absolute/path/to/unity"
args = ["mcp", "--project-path", "/absolute/path/to/UnityProject"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

Unity CLI can list supported client configuration targets with `unity mcp configure --list`.
Inspect generated client configuration before committing it.

### 5. Verify the target Editor

With the intended Editor open and compilation complete:

```sh
unity status
unity command --project-path "/absolute/path/to/UnityProject"
```

Then connect a fresh MCP client and call `editor_status`. Require the exact project path, a ready
Editor, and `compiling=false` before any mutation.

## Official command map

| Task | Official Pipeline command |
| --- | --- |
| Inspect Editor state | `editor_status` |
| Read Console entries | `get_console_logs` |
| Execute live C# | `eval`, `eval_file` |
| Discover and run tests | `list_tests`, `run_tests`, `test_status` |
| Control Play Mode | `editor_play`, `editor_pause`, `editor_stop` |
| Capture camera or Scene view | `capture_game_view`, `capture_scene_view` |
| Discover custom project commands | `unity command --project-path <path>` |
| Inspect router and auth state | `unity_router_status` |
| Force-restart a stuck `unity mcp` child | `unity_router_restart` |
| Refresh the Unity Cloud credential | `unity_auth_refresh` |

Use typed commands before `eval`. Use normal file tools for source, JSON, YAML, and serialized
asset edits; `eval` is for live Editor inspection or a deliberately scoped Editor API action.

## Compatibility commands

### `zamgune_play_begin`

Requests Play Mode and establishes a paused automation session with `Time.timeScale=0`. Entering
Play Mode can reload the domain, so reconnect and check `editor_status` before stepping.

### `zamgune_play_step`

Advances time for `duration_ms`, injects optional named InputActions, captures logs, releases all
injected state, restores focus/background settings, and returns to `Time.timeScale=0`.

```json
{
  "options": {
    "duration_ms": 1000,
    "input_action_asset_path": "Assets/InputSystem_Actions.inputactions",
    "inputs": [
      { "action": "Player/MoveRight", "type": "hold" },
      { "action": "Player/Jump", "type": "press" }
    ]
  }
}
```

### `zamgune_capture_game_view`

Captures the final Play Mode Game View through Unity's screenshot path. Use it when overlay UI must
be present; Pipeline's `capture_game_view` is camera-rendered and can omit `ScreenSpaceOverlay`
canvases.

### `zamgune_play_end`

Releases/reset input state, restores the original time scale, and requests Edit Mode. Call it during
normal completion and failure recovery.

See the [package documentation](Packages/com.zamgune.unity-pipeline-compat/README.md) for the full
argument and cleanup contract.

## Development and verification

Opening this repository as a Unity project embeds the compatibility package from
`Packages/com.zamgune.unity-pipeline-compat`; the root manifest pins Pipeline and exposes the package
tests.

Before a release:

1. confirm package JSON and changelog versions agree;
2. check `git diff --check` and confirm unrelated user files are untouched;
3. run the compatibility Editor tests;
4. verify MCP command discovery and `editor_status` against this exact project path;
5. exercise begin, a one-second step, composed capture, and end twice;
6. confirm Console errors and stuck inputs are zero.

The `0.1.0` command implementation was validated across UnityMCPTest, OhMyFarm, and Sheep-Wolf
before this official-first release. `0.2.0` preserves that command contract and changes the
repository's supported/default route.

## Legacy rollback only

The legacy source remains at `Assets/Plugins/UnityCodeMcpServer` and its transport documentation is
in [README_STDIO.md](README_STDIO.md). It remains version `0.7.0`; no official CLI capability is
implied by that package version.

Because that source is intentionally retained inside this repository's Unity test project, the
Editor still compiles it and can start its idle file watcher. No active MCP configuration points to
that watcher. The repository settings redirect its auto-installed legacy skills into ignored
`Library/LegacyUnityCodeMcpServerSkills`; the only active Unity automation skill is the official
Pipeline skill under `.agents/skills`.

Do not install both paths as permanent defaults. If rollback is required, restore the legacy package
and old MCP configuration as one reversible change, diagnose the official-path failure, and return
to the official CLI after verification.

## Security

Both Pipeline `eval` and the legacy server can execute C# with Unity Editor privileges. Review
generated code, pin the exact project path, prefer a clean worktree for destructive validation, and
inspect Git state after automation.

## License

MIT. The retained legacy package is a fork of
[Signal Loop's UnityCodeMCPServer](https://github.com/Signal-Loop/UnityCodeMCPServer).
