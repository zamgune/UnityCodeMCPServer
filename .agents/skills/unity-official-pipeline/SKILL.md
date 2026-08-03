---
name: unity-official-pipeline
description: Use for Unity Editor automation, tests, timed InputAction play, and captures through the official Unity CLI MCP, com.unity.pipeline, and the Zamgune compatibility package.
---

# Unity Official Pipeline

Use Unity's official CLI MCP through the installed machine-wide broker. Codex and Claude Code must
use the same stable adapter and project-local default:

```toml
[mcp_servers.unity]
command = "/Users/<account>/.unity-mcp-router/bin/unity-mcp-adapter"
args = ["--default", "UnityCodeMCPServer"]
startup_timeout_sec = 90
tool_timeout_sec = 310
```

Every tool takes an optional `project` argument selecting which Unity project to target; it defaults
to the router's configured default. Omit it unless working across projects.

## Command map

| Task | Command |
| --- | --- |
| Editor state | `editor_status` |
| Console inspection | `get_console_logs`, `clear_console` |
| Live C# | `eval`, `eval_file` |
| Tests | `list_tests`, `run_tests`, `test_status`, `cancel_tests` |
| Play control | `editor_play`, `editor_pause`, `editor_stop` |
| Camera or Scene capture | `capture_game_view`, `capture_scene_view` |
| Begin deterministic paused play | `zamgune_play_begin` |
| Advance with named InputActions | `zamgune_play_step` |
| Final capture including overlay UI | `zamgune_capture_game_view` |
| End deterministic play and restore state | `zamgune_play_end` |
| Router, child process, and auth state | `unity_router_status`, `unity_router_doctor` |
| Refresh credential status | `unity_auth_refresh` |

Drain/resume and operation resolution are maintenance actions. Ordinary adapters receive
`ADMIN_REQUIRED`; use only the bounded commands exposed by the installed stable admin CLI and the
operations guide after independently verifying the relevant state. Project-child restart is not
exposed by that stable wrapper; it is reserved for the audited source-tree soak harness.

## Workflow

1. Call `editor_status`. Require the exact canonical path, a ready Editor, and
   `compiling=false`.
2. Read recent error logs. Fix compiler errors before tests or Play Mode.
3. Prefer typed commands; reserve `eval` for a scoped live query or Editor API operation.
4. Use normal file tools for source and project files. Never create or overwrite them through
   `eval`.
5. After source edits, wait for compilation/domain reload and reconnect before issuing another
   mutation.
6. On Pipeline `0.4.0-exp.1`, never use synchronous `run_tests` or async `mode=all`. Run the
   narrowest filter with explicit `mode=editor` or `mode=playmode` and `async_tests=true`, poll
   `test_status` to terminal, and validate total, failed, skipped, inconclusive, and every returned
   test result. Run EditMode and PlayMode separately when both are required. A lost dispatch
   response is an unknown outcome and must not be retried.
7. For named input, call `zamgune_play_begin`, verify status after Play Mode entry, call one or more
   `zamgune_play_step` operations, and always finish with `zamgune_play_end`.
8. Use `zamgune_capture_game_view` only in Play Mode when overlay UI must be visible.
9. End in Edit Mode, confirm Console errors are zero, and inspect Git state.

Example timed step:

```json
{
  "options": {
    "duration_ms": 1000,
    "inputs": []
  }
}
```

## Safety

- Never start raw `unity mcp`, the source-tree router, or the legacy Python bridge beside the
  managed broker. Direct offline diagnostics must include the exact `--project-path`.
- Do not issue duplicate mutation calls during compile or domain reload.
- A transport timeout, stale MCP token, modal dialog, dirty scene, or stalled Test Runner is not a
  pass.
- On `401 Unauthorized`, call `unity_router_status` or `unity_auth_refresh` and verify sign-in.
  The broker may replace an unhealthy child, but it automatically retries only explicitly
  classified safe reads. It never replays a dispatched mutation. If the CLI is signed out, tell the
  user to run `unity auth login` and reconcile any uncertain operation before another mutation.
- On a "no Editor connected" failure, confirm the target project's Editor is open and done
  compiling before retrying. The router restores authentication, never the Editor process.
- Preserve unrelated scenes, assets, settings, and user files.
- The official path depends on no Python, uv, UniTask, copied bridge, or background file watcher.
  Pipeline 0.4 compatibility requires exactly one tracked `EditorPipelineManager` settings asset
  with `AutoStart=false`; a missing or duplicate asset is a fail-closed setup error. This repository
  still compiles the rollback-only legacy source, whose idle watcher can run while developing the
  repository itself.
- The old UnityCodeMCPServer tools are rollback-only and must not be used for normal verification.
