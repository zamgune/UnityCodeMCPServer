# Unity Pipeline compatibility commands

## Unity 6000.5 build environment

`zamgune_build_environment_status` is a read-only main-thread command. It reports the exact Unity
and project identity, Editor compile/import/Play readiness, active build target, Android/iOS/macOS
support, and the Build Profiles and installed platform modules exposed by Unity 6000.5. Build
Profile `EntityId` values are unsigned decimal strings so JavaScript MCP clients retain all 64 bits.
Unity 6000.0 through 6000.4 receive the same stable schema with the 6.5-only arrays empty and
`buildProfileApisAvailable=false`. The command never activates a profile or changes build targets.

## Single-seat Editor handoff

Use `zamgune_handoff_status` before moving the one active Unity Editor seat to another project. Its
`canClose` value is true only for a non-batch Editor in stable Edit Mode that is not compiling or
updating, has no dirty or untitled scene, and has no Prefab Stage open. `blockers` is authoritative;
the broker must not attempt to repair a blocker by saving, discarding, or stopping Play Mode.

To close, call `zamgune_editor_close` with the exact `projectPath` and `currentPid` returned by
status as `expectedProjectPath` and `expectedPid`, plus a unique non-empty `transitionId`. A path or
PID mismatch blocks the request, preventing a stale router decision from closing a replacement
Editor. The first accepted request reserves that transition. Repeating the identical transition
returns `already_scheduled` without scheduling again; any other transition remains blocked until
the first request is cancelled by its safety recheck or the Editor process closes.

The command waits 750 ms, repeats its complete identity and safety probe, and invokes the Unity
`File/Close` menu once. It never calls `EditorApplication.Exit` or sends a force signal. It does not
automatically save, discard, or stop Play Mode. If an unsaved custom asset window is outside the
enumerated scene/Prefab Stage state, Unity's native save confirmation is the final defense and the
handoff queue must wait for the original PID to disappear rather than assuming the request closed
the Editor.

## Structured asynchronous test status

Pipeline `0.4.0-exp.1` keeps the official `run_tests` input contract and writes asynchronous state
to `Temp/pipeline_test_request.json` and `Temp/pipeline_test_status.json`, but its public
`test_status` command serializes that state as a JSON string without `isRunning`. Unity CLI
`1.0.0-beta.3` adds a hidden poll after `run_tests` and only returns the MCP tool result after it
receives an object with `isRunning=false`. Without compatibility, a completed test run can therefore
hold the CLI request until its ten-minute deadline.

The compatibility discovery retains exactly one official `TestCommands.RunTests` method and
replaces exactly one official `TestCommands.GetTestStatus` method. The replacement parses the
official string into an object, preserves `status`, `summary`, `results`, and `message`, and forces
`isRunning=false` only to release beta.3's transport poll. `status` remains authoritative: a broker
must continue polling `running` or `in_progress` and stop only on a terminal status. When the
Pipeline request marker exists, `running` takes precedence over an older completed status file;
malformed, missing-field, or unknown status payloads return a terminal `error` object rather than
wedging the CLI.

Use `run_tests` only with an explicit `editor` or `playmode` mode and `async_tests=true`. Never
retry a trigger whose delivery is uncertain; inspect `test_status` and the router operation journal
first. Pipeline's status files do not contain a run ID, so direct clients outside the broker must
not start overlapping runs.

## Structured recompile status

Pipeline `0.4.0-exp.1` persists recompile state in
`Temp/pipeline_recompile_status.json`, but its public `recompile_status` command returns that JSON as
a string. This package requires exactly one official `EditorPipelineManager` settings asset with
`AutoStart=false`. On each main-process domain load, Phase A forces official Pipeline
initialization, immediately stops its server, and installs a discovery that exposes none of the
protected test or recompile triggers/status handlers. Phase B is driven by bounded editor events:
domain reload and relevant asset/folder events
from `AssetPostprocessor`, in-memory `EditorPipelineManager` property changes from
`ObjectChangeEvents.changesPublished`, and `OnWillSaveAssets` as a secondary save-time path. It
validates the settings gate, decorates public command discovery, validates the replacement, and only
then starts the server. It removes exactly
`Unity.Pipeline.Editor.Commands.RecompileCommand.Recompile` and `RecompileStatus`, and retains
exactly one compatibility status command and one official trigger for each protected lifecycle.

Cold initial import is retried without `EditorApplication.delayCall` polling. If the settings YAML
is not indexed during the first Phase-B attempt, Pipeline remains stopped; importing the canonical
settings path, any loadable `EditorPipelineManager` asset, or a previously discovered settings path
triggers another bounded attempt.

Path relevance includes exact matches and parent folders of the canonical or previously discovered
manager asset. Imported or moved folders are searched for contained `EditorPipelineManager` assets;
deleted and move-from parent paths are matched by ancestry even though those folders no longer
exist. Inspector property events are resolved by changed instance and asset GUID, so an unsaved
`AutoStart=true` change stops the server and disables all protected commands on the published
object-change event.

Pipeline `0.4.0-exp.1` has an unavoidable upstream first-import gap. Before the settings asset is
indexed, its initializer applies the built-in `AutoStart=true` default. Phase A must force that
initializer before it can call `StopServer`, so the official listener may be open for a brief,
typically millisecond-scale but not timing-guaranteed, interval. The compatibility package does not
claim to eliminate that interval. It guarantees that after Phase A returns the server is stopped
and all protected test/recompile commands are disabled until Phase B succeeds.

The compatibility handler returns `status`, `failed`, `errors`, and `isCompiling` as a structured
object. It preserves Pipeline's compiler-error array. Every persisted `triggered`, `compiling`,
`completed`, or `up_to_date` object must contain an exact boolean `failed` field and an `errors`
array containing only strings. Missing, null, or wrongly typed fields return `status=error`; a
persisted `idle` object is also rejected. Only a missing status file synthesizes the safe
`idle`, `failed=false`, empty-errors response. `isCompiling` is derived only from persisted state and
is true only for `compiling`; `triggered` represents pending intent, and the background handler never calls
`EditorApplication`.

The compatibility `recompile` handler preserves Pipeline's default behavior: `focus=false` and
`force=false` delegate directly to the official command. The optional `force=true` path is intended
only for explicit lifecycle canaries. It performs the official refresh first and, only when no
compilation started, persists `triggered` before requesting
`CompilationPipeline.RequestScriptCompilation(CleanBuildCache)`. This produces a source-neutral
clean compilation that the MCP router can track through `recompile_status`. It never requests a
second compilation when the official refresh already started one, never retries a rejected request,
and never requests compilation if status persistence failed.

Startup and discovery fail closed. If the settings asset is missing, duplicated, unloadable, or has
`AutoStart=true`, or if the official method is missing, duplicated, renamed, claimed by another
method, or any Phase-B operation throws, the server remains stopped, an Editor error is logged, and
none of the protected commands is exposed. All unrelated Pipeline commands remain
unchanged.

This does not intercept the official `Pipeline/Start Server` menu action. A manual Start while the
gate is invalid can start upstream Pipeline with status discovery still disabled until another
relevant settings event occurs. Recovery should be performed by correcting the settings asset, not
by using that menu action.

## Lifecycle

1. Call `zamgune_play_begin`.
2. Wait for the Editor to finish entering Play Mode and reconnect after any domain reload.
3. Call `zamgune_play_step` one or more times. Each step starts from and returns to
   `Time.timeScale=0`.
4. Call `zamgune_capture_game_view` when the final composed Game View, including overlay UI, is
   required; query logs through the normal Pipeline command as needed.
5. Call `zamgune_play_end` to restore the original time scale and leave Play Mode.

Each step accepts `duration_ms` from `0` through `300000` inclusive so one request cannot outlive
the configured 300-second agent tool timeout.

The session marker and original time scale are stored with Unity `SessionState`, so the lifecycle
survives the domain reload that commonly occurs while entering Play Mode. They do not persist after
the Editor process exits.

## Input resolution

- An explicit `input_action_asset_path` must identify an existing InputActionAsset.
- Without an explicit path, assets under `Assets` are sorted by path and the first is selected.
- Only when `Assets` contains no InputActionAsset does discovery consider all loaded assets.
- `action` accepts an exact action name or `Map/Action` path understood by
  `InputActionAsset.FindAction`.
- The first resolved control is injected, matching the legacy `play_unity_game` behavior.
- Unknown actions and actions without a resolved control are returned as warnings; other valid
  inputs still run.

## Safety and cleanup

Only one step may run at a time. Every step uses a `finally` cleanup path that:

- releases injected press/hold states;
- resets every Input System device to clear residual state;
- restores actions that the package temporarily enabled;
- re-disables devices that were disabled before the step;
- restores Input System focus settings and `Application.runInBackground`;
- restores the Editor pause flag and sets `Time.timeScale=0`.

If the Editor leaves Play Mode during a step, the command returns a failure response after cleanup.
If a domain reload interrupts the HTTP request itself, the client may receive a disconnect instead;
after reconnecting, call `editor_status`, then either resume with another step or call
`zamgune_play_end`.

## Final-composited Game View capture

`zamgune_capture_game_view` is intentionally separate from Pipeline's camera-rendered
`capture_game_view`. It calls `ScreenCapture.CaptureScreenshot` in Play Mode, waits on
`EditorApplication.update` for at most five seconds, and therefore captures Unity's final Game View
composition, including `ScreenSpaceOverlay` canvases that do not appear in an off-screen camera
render.

The only command argument is `max_height`, which defaults to `640` and must be between `1` and
`4096` inclusive. Images taller than the limit are scaled proportionally; smaller images are not
upscaled. The result reports `Success`, `Error`, PNG `Base64`, `Width`, `Height`, `Bytes`, and a
`Source` identifying `ScreenCapture.CaptureScreenshot`.

The screenshot is staged in a unique directory below the project's `Temp` folder. No save-path
argument is exposed. The temporary PNG is deleted after reading, and texture and render-texture
state used for optional scaling is restored in `finally` cleanup. Incomplete or not-yet-decodable
PNG data remains pending until the five-second timeout. A timed-out request keeps its staging path
available while a bounded Editor-update observer watches for and removes a complete late capture;
it never removes an empty path ahead of Unity's pending screenshot writer.

## Response boundary

Compatibility command responses contain their own `Success` and `Error` fields inside Pipeline's
normal command envelope. Validation failures that prevent deserialization are reported by Pipeline;
lifecycle, capture, or runtime failures are reported by the compatibility response so cleanup and
captured diagnostic data can still be returned.
