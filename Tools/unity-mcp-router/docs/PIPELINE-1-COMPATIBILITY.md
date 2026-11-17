# CLI 1.0.1 / Pipeline 1.0 compatibility

The broker recognizes the official grouped MCP names without rewriting a caller's
tool name or arguments. Earlier projects and their persisted async journals retain
their original contracts. Unknown and `global_*` custom commands remain mutations
unless an exact project-owned policy explicitly says otherwise.

| Operation | Pipeline 1.0 MCP trigger | Completion query |
| --- | --- | --- |
| Tests | `test_run` with `"async-tests": true` | `test_status` |
| Recompile | `script_recompile` | `script_recompile_status` |
| Build | `build_run` | `build_status`, matching `buildId` |
| Target switch | `build_target_switch` | `build_target_switch_status` |
| Package add/remove | `package_add` / `package_remove` | `package_status` |

The test tracker permits `test_cancel` while retaining its existing leases.
Package `wait: true` and both old `dry_run: true` and new `"dry-run": true` do not
start async tracking. Compile success refreshes the catalog once. After a broker
restart, known jobs are observed using their exact status name; no mutation is
replayed and uncertain trigger delivery still produces an `UNKNOWN_OUTCOME` fence.

Known grouped scene, hierarchy, console, test-list and completion queries receive
the existing safe-read policy. Script execution, Play Mode, build and test mutations
remain subject to ownership and serialization. No Editor lifecycle, licensing or
project selection setting is changed by this compatibility update.

## Unsaved-scene guard

The maintained source is `scripts/unity_dialog_guard.py`. On this workstation it is
installed at `~/.claude/tools/unity_dialog_guard.py`, beside the existing
`unity_fence_heal.py` managed-adapter client. The guard imports only that client's
`Adapter` on a real probe; it does not invoke its fence-recovery routine. The stable
Router adapter is connect-only. Neither `--self-test` nor the tests below contact a
broker or start Unity.

The guard discovers `scene_list_open` from the complete tool catalog, falling back
to `list_open_scenes` only when the catalog advertises that legacy name. It accepts
both the new scene array and the old `{ "scenes": [...] }` response. Malformed,
conflicting or unavailable results are never reported as a clean scene check.

It recognizes `test_run`, `script_eval` (inline code or a file), and `script_run`, as
well as the old names. Relative script files use the selected project's root from
the installed Router config; a missing file does not fall back to a different
same-named file in the agent's working directory.

Before replacing the installed file, back it up and preserve its permissions. In
Claude's existing `PreToolUse` entry for this guard, retain the command and timeout
and extend its matcher to:

```text
mcp__unity__run_tests|mcp__unity__eval|mcp__unity__eval_file|mcp__unity__run_script|mcp__unity__test_run|mcp__unity__script_eval|mcp__unity__script_run
```

`--check PROJECT` exits **0** for clean, **2** for dirty, and **1** for unavailable or
invalid evidence. Hook mode retains its earlier fail-open behavior with an explicit
unchecked note when a probe fails. The guard never saves or discards a scene, clears
a Router fence, closes an Editor, or retries a mutation.

## Editor-free validation

From `Tools/unity-mcp-router`:

```sh
node --test test/unit/*.test.mjs
python3 -B -m unittest discover -s test/python -v
python3 -B scripts/unity_dialog_guard.py --self-test
```

The existing full integration and installer suites also start isolated **broker
processes**, even though they use a fake Unity CLI and never start an Editor. Run
`node --test test/integration/broker-adapter.test.mjs` and
`node --test test/installer/*.test.mjs` only in an isolated environment or a separate
maintenance window. A production broker's machine-wide duplicate-broker audit can
detect these fixtures and temporarily block other sessions. A private temporary
prefix alone does not isolate the process audit. Do not disable that audit to run
tests beside active project work.

The new broker tests use a fake CLI 1.0.1 catalog containing only grouped command
names and exercise cancellation, delivery acknowledgement, compile notifications,
restart recovery and non-replay. The guard tests use injected adapters and temporary
files. Installer staging uses a private temporary prefix and never contacts live
launchd. Follow the existing installation/rollback procedure; retain the active
config and installed local changes, and do not restart a broker with another
session's workspace turn or unresolved operation.

These checks do not establish actual Editor import, compilation, scene handling,
Play Mode or device behavior. Validate those in each project during its next
authorized Unity session. Historical live canary/soak scripts retain their original
legacy catalog contract; they are not part of these Editor-free checks.

Command contracts were checked against the downloaded official
`com.unity.pipeline@1.0.0` source (`CommandNames.cs`, `TestCommands.cs`,
`RecompileCommand.cs`, build/package/scene commands and `CodeEvalCommand.cs`) and
the [Unity command naming conventions](https://docs.unity.com/en-us/unity-cli/command-name-conventions).
