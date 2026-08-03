# Changelog

## [0.4.0] - 2026-08-03

- Added `zamgune_handoff_status` with exact project/PID identity, compile/import and Play Mode
  state, open-scene dirty/untitled state, Prefab Stage state, and fail-closed blockers.
- Added `zamgune_editor_close`, requiring `expectedProjectPath`, `expectedPid`, and `transitionId`.
  It reserves one idempotent transition, repeats the complete safety check after a 750 ms response
  window, and invokes Unity's normal `File/Close` menu exactly once.
- Kept all destructive policy outside the command: it never saves, discards, stops Play Mode,
  calls `EditorApplication.Exit`, or sends a process signal. Batch mode is always blocked.
- Added Editor tests for command metadata, clean readiness, every safety/identity blocker,
  idempotent scheduling, delayed recheck cancellation, and menu/scheduler failure recovery without
  closing the test Editor.

## [0.3.0] - 2026-08-02

- Pinned the official Unity Pipeline dependency to `0.4.0-exp.1` for authentication-token
  persistence across domain reloads.
- Replaced the official `recompile` and JSON-string `recompile_status` discovery entries as one
  fail-closed pair. The default trigger delegates to official behavior unchanged; opt-in
  `force=true` requests a source-neutral CleanBuildCache script compilation for reload canaries.
- Kept Pipeline 0.4's official `run_tests` command and schema, while replacing its JSON-string
  `test_status` with a structured object for Unity CLI `1.0.0-beta.3`. The compatibility response
  preserves the authoritative `status` and test results while forcing `isRunning=false` solely to
  release beta.3's hidden MCP poll; broker polling continues until `status` is terminal.
- Made a pending `Temp/pipeline_test_request.json` take precedence over a stale completed status
  during test startup, and made malformed or unknown status payloads fail closed as terminal errors.
- Added a structured, background-safe status response containing `status`, `failed`, `errors`, and
  persisted-state-derived `isCompiling`.
- Added exact discovery invariants that fail closed if any protected upstream command identity
  changes or a duplicate test/recompile trigger/status handler appears.
- Added a two-phase fail-closed bootstrap. Phase A forces official initialization, immediately stops
  the server, and disables `run_tests`, `test_status`, `recompile`, and `recompile_status`; bounded `AssetPostprocessor`
  events drive Phase B,
  which validates exactly one `AutoStart=false` settings asset and compatibility discovery before
  starting the server. Cold imports automatically retry when the settings asset becomes available.
- Documented Pipeline 0.4's unavoidable brief first-import listener interval between its built-in
  `AutoStart=true` fallback and Phase A's immediate `StopServer` call.
- Added `ObjectChangeEvents` instance/GUID filtering and a save-time fallback so unsaved Inspector
  changes to `EditorPipelineManager`, including `AutoStart=true`, immediately re-enter fail-closed
  Phase B validation without polling.
- Added exact-or-parent path matching and contained-manager folder discovery for import, move,
  deletion, and move-from events. Documented that the official manual Start menu remains outside
  compatibility enforcement.
- Tightened persisted status parsing so `failed` and string-array `errors` are mandatory for every
  non-idle state; only a missing status file can synthesize `idle`.
- Added focused Editor tests for strict status conversion, compiler-error preservation, the no-file
  idle boundary, default delegation, force-request ordering/failure behavior, settings validation,
  bounded bootstrap-event policy, property-event classification, path ancestry, folder coverage,
  and trigger/status discovery invariants/postconditions without triggering compilation or a domain
  reload.

## [0.2.0] - 2026-07-22

- Promoted the official Unity CLI and `com.unity.pipeline` integration to this repository's
  default path.
- Kept the compatibility surface intentionally limited to deterministic InputAction timed play
  and final-composited Play Mode capture.
- Documented the published UnityCodeMCPServer and Python/uv bridge at `0.7.0` as rollback-only
  components.
- Kept the `zamgune_*` command contract from `0.1.0` unchanged.

## [0.1.0] - 2026-07-22

- Added `zamgune_play_begin`, `zamgune_play_step`, and `zamgune_play_end` Unity Pipeline commands.
- Added `zamgune_capture_game_view` for final-composited Play Mode PNG capture, including
  `ScreenSpaceOverlay` UI, with bounded polling and proportional height scaling.
- Added structured InputAction-name based `press` and `hold` simulation.
- Added focus bypass, device reset/release, console capture, and time-scale restoration.
- Added Editor tests for capture command metadata, height validation, and scaling, plus migration
  documentation for the capture boundary.
