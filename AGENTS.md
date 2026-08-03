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

Unity Personal is operated as `single-seat` with one Editor. Agents may edit source in different
repositories concurrently, but must never act as concurrent writers in the same repository. Every
Unity import, recompile, test, build, Game View capture, and final Console check requires the one
machine-wide validation turn described in
`Tools/unity-mcp-router/docs/SINGLE-SEAT-HANDOFF.md`.

## Official command workflow

1. In the same MCP session that will validate, call `unity_router_workspace_begin` for the project.
   Preserve the returned token before inspecting `editorUse`. Only a non-null operation ID that
   reaches `COMPLETED` permits validation; heartbeat the token while polling it with
   `unity_router_editor_use_status`. In `WAITING_MANUAL_CLOSE`, wait for the user to close the
   current Editor normally. If the operation ID is missing or the handoff is terminal without
   `COMPLETED`, do not validate and immediately return the token with `unity_router_workspace_end`.
   If end reports `WORKSPACE_EDITOR_HANDOFF_ACTIVE`, keep heartbeating, wait for the reported
   handoff to become terminal, and retry end. Never let the retained lease expire silently.
2. Call `editor_status` and require the exact project path, `status=ready`, `compiling=false`, and
   stopped Play Mode. An inactive project's safe read returns `PROJECT_EDITOR_INACTIVE`; it must not
   wake or switch the Editor in the background.
3. Call `get_console_logs` for recent errors before tests or Editor mutation.
4. Prefer typed Pipeline commands. Use `eval`/`eval_file` only when no typed command expresses the
   operation.
5. Use normal file tools for source, JSON, YAML, and serialized project files; do not write them
   through `eval`.
6. After C# edits, wait for compilation/domain reload, reconnect if needed, re-check
   `editor_status`, and fix compiler errors before testing.
7. With Pipeline `0.4.0-exp.1`, never use synchronous `run_tests` or async `mode=all`. Run the
   narrowest filter with an explicit `mode=editor` or `mode=playmode` and `async_tests=true`, then
   poll `test_status` to a terminal state. Run the two modes separately when both are required.
   Inspect the structured total, failed, skipped, inconclusive, and per-test results instead of
   treating request completion or `status=completed` as a pass. Never redispatch a test mutation
   whose response was lost; resolve its router operation only after independent terminal evidence.
8. For timed InputAction play, use `zamgune_play_begin`, one or more structured
   `zamgune_play_step` calls, and `zamgune_play_end` in normal and failure cleanup.
9. Use `zamgune_capture_game_view` when evidence must include overlay UI. Use Pipeline
   `capture_game_view` only when a camera-rendered capture is sufficient.
10. Stop Play Mode, re-check Console and Git state, wait for every tracked async operation and
    import/compile to become terminal, then call `unity_router_workspace_end` with the original
    token. A failed end is a retained fence, not permission to proceed.

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
- Do not switch to `editorHandoff.mode=typed-auto-close` until all five embedded compatibility
  packages match and the disposable negative tests plus clean A -> B -> A live canary in the
  single-seat handoff guide have passed.
- `zamgune_editor_close` may only schedule Unity `File/Close` after exact project path, PID and
  transition identity checks. Never save, discard, stop Play Mode, answer a modal, send `TERM` or
  `KILL`, or retry close/open after uncertain delivery.
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
