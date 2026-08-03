# Unity CLI, Pipeline Compatibility, and Managed MCP Router

This repository is the source of truth for two maintained components:

- `com.zamgune.unity-pipeline-compat`, an Editor-only compatibility package for Unity's official
  CLI and `com.unity.pipeline`;
- `Tools/unity-mcp-router`, a macOS machine-wide broker that lets Codex and Claude Code share the
  official `unity mcp` process without starting duplicate brokers or replaying uncertain mutations.

The old `com.signal-loop.unitycodemcpserver` package and Python/uv bridge remain at `0.7.0` for
rollback only. They are not part of the normal automation path.

## Validated baseline

| Component | Validated version | Role |
| --- | --- | --- |
| Unity Editor | `6000.3.17f1` | Pipeline host used for the 2026-08-03 live gates |
| Unity CLI | `1.0.0-beta.3` | Official CLI and MCP child process |
| `com.unity.pipeline` | `0.4.0-exp.1` | Official Editor command surface |
| `com.zamgune.unity-pipeline-compat` | `0.3.0` | Structured test/recompile status, timed input, composed capture |
| Input System | `1.19.0` | Named InputAction injection |
| `Tools/unity-mcp-router` | `2.0.0-dev` | LaunchAgent broker, adapters, leases, journal, install and rollback |

Unity CLI is beta, Pipeline is experimental, and router v2 is still an unreleased development
build. Pin exact versions and rerun the relevant gates before upgrading any of them. The completed
machine validation and its proof boundary are recorded in
[VALIDATION-2026-08-03.md](Tools/unity-mcp-router/docs/VALIDATION-2026-08-03.md).

Official references:

- [Unity CLI documentation](https://docs.unity.com/en-us/unity-cli)
- [Unity CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference)
- [Unity Pipeline package](https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package)

## Runtime architecture

Codex and Claude Code each start a small stdio adapter. Every adapter connects to the same broker,
which is owned by a macOS user LaunchAgent. The broker owns at most one official `unity mcp` child
per canonical Unity project.

The important boundaries are:

- edit source only in this repository; do not edit `~/.unity-mcp-router/current` or an installed
  release directory;
- register only the stable installed adapter in clients; do not run raw `unity mcp`, the
  source-tree router, or the legacy Python bridge beside it;
- same-project requests are serialized, heavy work is globally bounded, and source refresh uses a
  durable workspace lease;
- a mutation is never automatically replayed after dispatch. A timeout, cancellation, or lost
  response becomes `UNKNOWN_OUTCOME` until independently reconciled;
- the validated default is one Unity Editor with multiple Codex/Claude clients. Two simultaneous
  Editors require a configured floating license server with two available seats and a separate
  two-Editor soak; increasing a config number alone is not sufficient.

See the [router README](Tools/unity-mcp-router/README.md) for configuration and installation, and
the [operations guide](Tools/unity-mcp-router/docs/OPERATIONS.md) for rollout, incident, soak, and
rollback procedures.

## Install the official project path

### 1. Pin Unity CLI and Pipeline

Verify the exact CLI before opening a rollout gate:

```sh
unity --version
unity upgrade --check
```

For the validated project baseline, install Pipeline explicitly:

```sh
unity auth login
unity pipeline install \
  --project-path "/absolute/path/to/UnityProject" \
  --package-version 0.4.0-exp.1
```

Do not commit a moving Git dependency for the compatibility package. This repository embeds the
package at `Packages/com.zamgune.unity-pipeline-compat`; consuming projects use an audited embedded
snapshot and keep its lock stanza, package version, and Pipeline version together. If a Git
dependency is needed later, pin the release commit SHA or a published tag after that tag exists.

### 2. Install the managed broker

Copy `Tools/unity-mcp-router/unity-mcp-router.config.example.json` to the ignored
`unity-mcp-router.config.json`, set canonical project paths, and follow
[the versioned install procedure](Tools/unity-mcp-router/README.md#검증과-설치). The installer
creates immutable releases and deployments, copies a verified Node runtime into the managed
prefix, backs up named client configs, and switches `current` only after validation.

The stable client entrypoint is:

```text
/Users/<account>/.unity-mcp-router/bin/unity-mcp-adapter
```

### 3. Register Codex and Claude Code

Each project-local Codex config uses the same adapter and changes only the default alias:

```toml
[mcp_servers.unity]
command = "/Users/<account>/.unity-mcp-router/bin/unity-mcp-adapter"
args = ["--default", "UnityCodeMCPServer"]
startup_timeout_sec = 90
tool_timeout_sec = 310
```

Claude Code uses the same executable and alias in that project's local scope. Do not add an
additional user-scope raw Unity server. A template for Codex is available at
[.codex/config.toml.example](.codex/config.toml.example).

### 4. Verify the intended Editor

Open one Editor at the canonical project path and wait for import and compilation to finish. In a
fresh adapter session, call `unity_router_status`, then `editor_status`. Require the exact project
path, `status=ready`, and `compiling=false` before any mutation.

## Command contract

| Task | Command |
| --- | --- |
| Editor and Console state | `editor_status`, `get_console_logs` |
| Discover and run tests | `list_tests`, `run_tests`, `test_status`, `cancel_tests` |
| Compilation lifecycle | `recompile`, `recompile_status` |
| Play control | `editor_play`, `editor_pause`, `editor_stop` |
| Camera or Scene capture | `capture_game_view`, `capture_scene_view` |
| Timed named input | `zamgune_play_begin`, `zamgune_play_step`, `zamgune_play_end` |
| Final Game View including overlay UI | `zamgune_capture_game_view` |
| Broker state | `unity_router_status`, `unity_router_doctor`, `unity_router_operation_status` |
| Source-refresh ownership | `unity_router_workspace_begin`, `unity_router_workspace_heartbeat`, `unity_router_workspace_end` |

Use typed commands before `eval`. Use normal file tools for source, JSON, YAML, and serialized
project files; live evaluation is not a file-writing transport.

Pipeline `0.4.0-exp.1` tests have a strict transport contract with CLI beta.3:

- do not use synchronous `run_tests` or asynchronous `mode=all`;
- dispatch once with `async_tests=true` and explicit `mode=editor` or `mode=playmode`;
- poll `test_status` to a terminal state and inspect totals plus every returned result;
- run EditMode and PlayMode separately when both are required;
- never redispatch after a lost response; inspect the tracked operation and terminal status.

The compatibility package keeps the official `run_tests` input schema. It replaces only the
status boundary needed to release beta.3's hidden poll, normalizes persisted recompile state, and
adds an opt-in `recompile(force=true)` lifecycle canary. Its timed-input and composed-capture
commands retain the prior public contract. Full details are in the
[package README](Packages/com.zamgune.unity-pipeline-compat/README.md).

## Development and verification

The router tests do not require a Unity Editor:

```sh
ROUTER_SRC=Tools/unity-mcp-router
node --test "$ROUTER_SRC"/test/unit/*.test.mjs
node --test "$ROUTER_SRC"/test/integration/broker-adapter.test.mjs
node --test "$ROUTER_SRC"/test/installer/*.test.mjs
```

A release check also requires JSON parsing, `git diff --check`, compatibility Editor tests,
command discovery, live reload recovery, a timed Play step, composed capture, cleanup, and a final
Console/Git-state check. Static or fake tests do not replace live Unity evidence, and live Unity
evidence does not prove Android/iOS device behavior.

## Legacy rollback only

The legacy package remains under `Assets/Plugins/UnityCodeMcpServer`; its frozen transport is
documented in [README_STDIO.md](README_STDIO.md). Never register that bridge and the managed
adapter at the same time. Rollback is a reversible incident action, not a second permanent
configuration.

## Security

Pipeline evaluation and the retained legacy server execute with Unity Editor privileges. Keep the
project path exact, grant automatic approval only to the broker's explicit safe-read tools, use a
clean or fingerprinted checkout for destructive validation, and inspect staged files before every
commit.

## License

MIT. The retained legacy package is a fork of
[Signal Loop's UnityCodeMCPServer](https://github.com/Signal-Loop/UnityCodeMCPServer).
