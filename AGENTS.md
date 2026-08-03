# AGENTS.md

Agent guidance for contributors working in this repository.

## Scope

- The maintained/default integration is Unity's official CLI MCP plus `com.unity.pipeline`.
- The compatibility package lives under `Packages/com.zamgune.unity-pipeline-compat`.
- The executable source under `Assets/Plugins/UnityCodeMcpServer` and its Python stdio bridge are
  rollback-only legacy code frozen at embedded package version `0.7.0`. Do not extend them unless the task
  explicitly targets rollback maintenance.
- Follow a closer `AGENTS.md` if one is added later. Explicit user instructions override this file.

## Editing rules

- Make the smallest change that satisfies the request.
- Preserve unrelated dirty and untracked files.
- Do not change scenes, assets, generated project files, or settings outside the task.
- Add tests for behavior changes; documentation-only and version-only changes need structural
  validation but not invented runtime tests.
- Use snake_case for new private Unity C# fields to match repository style.

## Managed Unity connection

Codex and Claude Code must connect through the installed stable adapter. The project-local default
must be `UnityCodeMCPServer`:

```toml
[mcp_servers.unity]
command = "/Users/<account>/.unity-mcp-router/bin/unity-mcp-adapter"
args = ["--default", "UnityCodeMCPServer"]
startup_timeout_sec = 90
tool_timeout_sec = 310
```

The macOS user LaunchAgent is the only broker owner. Do not start raw `unity mcp`, the source-tree
router, or the legacy Python bridge beside it. Direct Unity CLI commands are limited to deliberate
offline diagnosis or rollback work and must always include the exact `--project-path`.

## Official command workflow

1. Call `editor_status` and require the exact project path, `status=ready`, and
   `compiling=false`.
2. Call `get_console_logs` for recent errors before tests or Editor mutation.
3. Prefer typed Pipeline commands. Use `eval`/`eval_file` only when no typed command expresses the
   operation.
4. Use normal file tools for source, JSON, YAML, and serialized project files; do not write them
   through `eval`.
5. After C# edits, wait for compilation/domain reload, reconnect if needed, re-check
   `editor_status`, and fix compiler errors before testing.
6. With Pipeline `0.4.0-exp.1`, never use synchronous `run_tests` or async `mode=all`. Run the
   narrowest filter with an explicit `mode=editor` or `mode=playmode` and `async_tests=true`, then
   poll `test_status` to a terminal state. Run the two modes separately when both are required.
   Inspect the structured total, failed, skipped, inconclusive, and per-test results instead of
   treating request completion or `status=completed` as a pass. Never redispatch a test mutation
   whose response was lost; resolve its router operation only after independent terminal evidence.
7. For timed InputAction play, use `zamgune_play_begin`, one or more structured
   `zamgune_play_step` calls, and `zamgune_play_end` in normal and failure cleanup.
8. Use `zamgune_capture_game_view` when evidence must include overlay UI. Use Pipeline
   `capture_game_view` only when a camera-rendered capture is sufficient.
9. Stop Play Mode and re-check Console and Git state before handoff.

## Package verification

- Authoritative version: `Packages/com.zamgune.unity-pipeline-compat/package.json`.
- Update `Packages/com.zamgune.unity-pipeline-compat/CHANGELOG.md` whenever that version changes.
- Package Editor tests live under `Packages/com.zamgune.unity-pipeline-compat/Tests/Editor` and are
  exposed through the root manifest's `testables` entry.
- A release check must include JSON parsing, `git diff --check`, command discovery, compatibility
  Editor tests, a one-second timed Play step, composed PNG capture, cleanup, and zero Console
  errors.
- Unity CLI is beta and Pipeline is experimental. Keep the validated CLI and Pipeline versions
  pinned; do not silently upgrade while proving an unrelated change.

## Safety boundaries

- A domain reload, stale MCP token, transport timeout, modal dialog, dirty scene, or stalled Test
  Runner is not a passing result.
- Do not run two mutation commands concurrently.
- Do not save unrelated dirty scenes or regenerate unrelated serialized assets.
- Do not publish tags, packages, or remote branches unless the user requested publication.
- Keep legacy rollback source intact unless the task explicitly authorizes its removal.

## Legacy maintenance

If a task explicitly changes `Assets/Plugins/UnityCodeMcpServer` or
`Assets/Plugins/UnityCodeMcpServer/Editor/STDIO~`, also follow the legacy test and packaging guidance
in `README_STDIO.md`. The published legacy UPM package and Python bridge remain in lockstep at
`0.7.0`; do not bump them as part of an official Pipeline release. The repository development
project's serialized settings instance may redirect generated legacy skills away from active agent
directories without changing that published executable release.
