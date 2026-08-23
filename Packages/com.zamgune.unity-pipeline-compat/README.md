# Zamgune Unity Pipeline Compatibility

Version `0.4.2` is an Editor-only companion to Unity's official CLI and `com.unity.pipeline`.
It keeps the InputAction-name based timed-play workflow from legacy `play_unity_game` and captures
the final composed Play Mode Game View without retaining the old custom MCP server. It also
normalizes Pipeline's persisted JSON-string `recompile_status` and `test_status` responses for
deterministic router polling. Its `recompile` replacement delegates to official behavior by default
and adds an explicit source-neutral `force=true` lifecycle-canary path. Its `test_status`
replacement closes the exact Pipeline 0.4 / Unity CLI beta.3 object-contract mismatch without
replacing the official `run_tests` implementation or input schema. It also exposes a typed,
fail-closed handoff contract so a single licensed Editor seat can move between projects without
process signals, automatic saves, or automatic discards.

## Requirements

- Unity 6 (`6000.0` or newer)
- Unity CLI `1.0.0-beta.3`
- `com.unity.pipeline` `0.4.0-exp.1`
- Input System `1.19.0`
- Exactly one official `EditorPipelineManager` settings asset in the project, with `AutoStart`
  disabled (recommended path: `Assets/Settings/Pipeline/EditorPipelineManager.asset`)

The package has no Python, uv, UniTask, or background file watcher. It does not create or mutate the
required official Pipeline settings asset.

The repository still contains UnityCodeMCPServer `0.7.0` as rollback source, but that package is
not installed or required by this compatibility package.

## Commands

### `zamgune_build_environment_status`

Returns Unity and project identity, Editor compile/import/Play readiness, active build target, installed
target support, and the Unity 6000.5 Build Profile inventory without changing profiles or targets.
Build Profile `EntityId` values are encoded as unsigned decimal strings so MCP clients do not lose
precision in JavaScript. On Unity 6000.0 through 6000.4 the stable response remains available with
`buildProfileApisAvailable=false`; the 6.5-only profile and installed-module arrays remain empty.

### `zamgune_handoff_status` and `zamgune_editor_close`

`zamgune_handoff_status` returns the canonical project path, current Editor PID, compile/import and
Play Mode state, every open scene with dirty/untitled flags, current Prefab Stage state, `canClose`,
and machine-readable `blockers`. Batch mode, compiling/updating, Play Mode or a transition, any
dirty or untitled scene, and any open Prefab Stage all block handoff.

`zamgune_editor_close` requires the exact `expectedProjectPath`, `expectedPid`, and a non-empty
`transitionId`. It rechecks those values and all handoff blockers, reserves the transition ID, then
schedules one `File/Close` menu invocation after a 750 ms response-delivery window. The delayed
callback repeats the complete safety and identity check. Repeating the same transition is
idempotent; a different transition is blocked while the first is pending. The command never saves,
discards, stops Play Mode, calls `EditorApplication.Exit`, or sends a process signal. Unity's own
save confirmation remains the final defense for dirty asset editors that cannot be enumerated.

Example typed call payload:

```json
{
  "expectedProjectPath": "/absolute/path/to/project",
  "expectedPid": 12345,
  "transitionId": "handoff-20260803-001"
}
```

### `run_tests` and `test_status`

`run_tests` remains Pipeline 0.4's official command. Use one explicit mode (`editor` or
`playmode`) with `async_tests=true`, then treat `status` from `test_status` as the only lifecycle
truth. Do not use synchronous test runs through MCP and do not retry a trigger whose response was
lost.

Unity CLI `1.0.0-beta.3` performs a hidden poll after every `run_tests` MCP call. That poll accepts
only an object whose `isRunning` member is `false`, while Pipeline `0.4.0-exp.1` returns
`test_status` as a JSON string and omits that member. Tests can finish successfully while the CLI
waits until its own ten-minute deadline. The compatibility handler parses Pipeline's string into a
structured object, preserves `status`, `summary`, `results`, and `message`, and injects
`isRunning=false` so beta.3 returns the current snapshot to the router. The value is deliberately a
transport escape hatch, not test state: `status=running` or `status=in_progress` still means the run
is active, and the router continues polling until a terminal `status` is observed.

While `Temp/pipeline_test_request.json` exists, the handler returns `status=running` before reading
an older status file. This prevents a stale completed result from winning Pipeline's bounded
request-write/status-delete start window. Missing or malformed status data and unknown lifecycle
values fail closed as `status=error`, always with `isRunning=false` so the CLI cannot wedge.

### `recompile`

Replaces exactly Pipeline 0.4's official discovery entry while keeping `focus=false` and normal
refresh behavior as the defaults. With `force=false`, the compatibility handler directly delegates
to the official command and returns its result unchanged. With `force=true`, it first performs that
official refresh. If compilation is already active, it returns the official result and never starts
a second compilation. Otherwise it persists `triggered` and requests
`CompilationPipeline.RequestScriptCompilation(CleanBuildCache)`, which forces a clean script
compilation without changing source bytes. This opt-in path exists for bounded domain-reload and MCP
reconnection canaries; routine agents should leave it disabled.

If status persistence fails, no clean compilation is requested. If Unity rejects the clean compile
request, the handler writes a terminal failed status and returns an error without retrying.

### `recompile_status`

Replaces the official Pipeline discovery entry for
`Unity.Pipeline.Editor.Commands.RecompileCommand.RecompileStatus`. The compatibility response is an object with `status`, `failed`,
`errors`, and `isCompiling`. Compiler errors from Pipeline's persisted status file are retained,
and `isCompiling` is true only for the persisted `compiling` state. `triggered` records pending
intent and does not claim that the Editor has observed compilation. Every persisted state must
contain a boolean `failed` field and a string-array `errors` field. Missing, null, or
wrongly typed fields fail closed. Only the absence of the status file synthesizes a safe `idle`
response.

Startup uses two bounded phases and no Editor-update polling. Phase A runs from `InitializeOnLoad`:
it forces official Pipeline initialization, immediately stops the server, and installs discovery
that exposes none of `run_tests`, `test_status`, `recompile`, or `recompile_status`. Phase B is
event-driven. It runs after a domain reload, a
relevant asset/folder import, move, edit, deletion, or save, and when
`ObjectChangeEvents.changesPublished` reports in-memory property changes for an
`EditorPipelineManager` instance or known GUID. Each attempt validates the single
`AutoStart=false` asset, installs the decorated discovery, verifies exactly one compatibility
handler for each protected status, preserves exactly one official trigger, and only then starts the
official server. A cold import that initially cannot see the
settings asset remains stopped and automatically retries when that asset finishes importing.

Folder handling is conservative and bounded: changing a parent of the canonical or previously
discovered settings path is relevant, as is importing or moving a folder that contains any
`EditorPipelineManager`. This covers deletion or move-out of a parent folder as well as manager
assets that arrive inside a moved folder. Inspector changes are evaluated from the in-memory object
before save; `OnWillSaveAssets` is a secondary safety path.

There is one upstream boundary this package cannot remove: during the first cold import, Pipeline
`0.4.0-exp.1` can treat its not-yet-indexed settings asset as missing and apply its built-in
`AutoStart=true` default. Phase A must force that initializer before it can take ownership, so the
official listener can exist for a brief, typically millisecond-scale but not timing-guaranteed,
interval before `StopServer`. After Phase A completes, the listener stays stopped and status stays
disabled until Phase B proves every precondition. Missing, duplicate, unloadable, or
`AutoStart=true` settings, discovery identity changes, duplicate protected handlers, and exceptions all
remain stopped and fail closed.

The official `Pipeline/Start Server` menu action remains outside this event-driven enforcement. If
it is invoked manually while the compatibility gate is invalid, upstream Pipeline can start its
server with `recompile_status` still disabled until the next relevant settings event. Do not use the
manual Start action as a recovery path; correct the settings and let Phase B start the server.

The status handler is background-safe (`MainThreadRequired = false`): it reads only
`Temp/pipeline_recompile_status.json` and does not query `EditorApplication`.

### `zamgune_play_begin`

Requests Play Mode and establishes a paused automation session. When Play Mode is entered,
`Time.timeScale` is set to `0`. The Editor can reload its domain while entering Play Mode, so
clients should reconnect and check `editor_status` before calling `zamgune_play_step`.

### `zamgune_play_step`

Takes one structured `options` object:

```json
{
  "duration_ms": 1000,
  "input_action_asset_path": "Assets/InputSystem_Actions.inputactions",
  "inputs": [
    { "action": "Player/MoveRight", "type": "hold" },
    { "action": "Player/Jump", "type": "press" }
  ]
}
```

`duration_ms` is required and must be between `0` and `300000` inclusive. The asset path is optional. When it is
omitted, the first InputActionAsset under `Assets` is selected deterministically; only if none is
present does discovery fall back to package assets. Inputs are optional, so the command can be used
only to advance game time.

During a step the package temporarily enables background execution, bypasses Input System focus
gating, re-enables devices that Unity disabled in the background, and clears residual device state.
It releases all injected input, resets devices, restores focus/background settings, and returns to
`Time.timeScale=0` even when the step fails. Captured console messages are returned in the response.

Example CLI call:

```sh
unity command --project-path /absolute/path/to/project --timeout 30 \
  zamgune_play_step \
  --options '{"duration_ms":1000,"inputs":[{"action":"Player/Jump","type":"press"}]}'
```

### `zamgune_play_end`

Releases/reset inputs, restores the time scale recorded by `zamgune_play_begin`, and requests a
return to Edit Mode.

### `zamgune_capture_game_view`

Captures the final Play Mode Game View through `ScreenCapture.CaptureScreenshot`, so the returned
PNG includes the image Unity presents in the Game View, including `ScreenSpaceOverlay` canvases.
Unlike Pipeline's camera-rendered `capture_game_view`, this command requires Play Mode and waits for
Unity to finish its end-of-frame screenshot.

```sh
unity command --project-path /absolute/path/to/project --timeout 15 \
  zamgune_capture_game_view --max_height 640
```

`max_height` defaults to `640` and accepts values from `1` through `4096`. Captures taller than the
limit are scaled proportionally without upscaling smaller images. The response contains `Success`,
`Error`, `Base64`, `Width`, `Height`, `Bytes`, and `Source`. Screenshot files are staged only under
the Unity project's `Temp` directory; the command exposes no output-path argument and deletes a
successful capture after encoding the response. After a timeout, a bounded
Editor-update observer keeps the staging path available for a late `ScreenCapture` write and removes
the PNG only after it is complete; if no file arrives, the empty directory is left under `Temp`
rather than being removed ahead of Unity's pending writer.

## Tests

Package Editor tests live under `Tests/Editor`. Add the package name to the consuming project's
`testables` array when running package tests through Unity Test Framework:

```json
"testables": ["com.zamgune.unity-pipeline-compat"]
```

The Editor tests cover build-environment schema and 64-bit ID encoding, command metadata, default trigger delegation, opt-in force behavior without
actually requesting compilation, strict persisted recompile-state conversion, structured
test-status conversion and beta.3 poll release, the no-file
idle boundary, settings validation, bounded Phase-B event policy, fail-closed discovery invariants
and postconditions, in-memory property classification, path ancestry and moved-folder coverage,
structured JSON input, deterministic asset resolution, simultaneous keyboard state, residual input
reset, capture-height validation, and proportional capture scaling. A live Unity CLI integration
pass is still required to prove the typed handoff catalog and real `File/Close`, cold-import
bootstrap, domain-reload reconnection and status
replacement, Inspector enforcement, folder moves, Play Mode transitions, timed game advancement,
focus behavior, and final-composited Game View capture.

See [Documentation~/index.md](Documentation~/index.md) for lifecycle and failure semantics.
