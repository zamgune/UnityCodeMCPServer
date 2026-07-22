---
name: unity-official-pipeline
description: Use for Unity Editor automation, tests, timed InputAction play, and captures through the official Unity CLI MCP, com.unity.pipeline, and the Zamgune compatibility package.
---

# Unity Official Pipeline

Use Unity's official CLI MCP for this repository. Bind every process to the exact project path:

```toml
[mcp_servers.unity_codemcp]
command = "/absolute/path/to/unity"
args = ["mcp", "--project-path", "/absolute/path/to/UnityCodeMCPServer"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

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

## Workflow

1. Call `editor_status`. Require the exact canonical path, a ready Editor, and
   `compiling=false`.
2. Read recent error logs. Fix compiler errors before tests or Play Mode.
3. Prefer typed commands; reserve `eval` for a scoped live query or Editor API operation.
4. Use normal file tools for source and project files. Never create or overwrite them through
   `eval`.
5. After source edits, wait for compilation/domain reload and reconnect before issuing another
   mutation.
6. Run the narrowest test filter first and inspect structured failed/skipped counts.
7. For named input, call `zamgune_play_begin`, verify status after Play Mode entry, call one or more
   `zamgune_play_step` operations, and always finish with `zamgune_play_end`.
8. Use `zamgune_capture_game_view` only in Play Mode when overlay UI must be visible.
9. End in Edit Mode, confirm Console errors are zero, and inspect Git state.

Example timed step:

```json
{
  "options": {
    "duration_ms": 1000,
    "input_action_asset_path": "Assets/InputSystem_Actions.inputactions",
    "inputs": [
      { "action": "Player/Jump", "type": "press" }
    ]
  }
}
```

## Safety

- Never omit `--project-path` when multiple Editors may be open.
- Do not issue duplicate mutation calls during compile or domain reload.
- A transport timeout, stale MCP token, modal dialog, dirty scene, or stalled Test Runner is not a
  pass.
- Preserve unrelated scenes, assets, settings, and user files.
- The official path depends on no Python, uv, UniTask, settings asset, copied bridge, or background
  file watcher. This repository still compiles the rollback-only legacy source, whose idle watcher
  can run while developing the repository itself.
- The old UnityCodeMCPServer tools are rollback-only and must not be used for normal verification.
