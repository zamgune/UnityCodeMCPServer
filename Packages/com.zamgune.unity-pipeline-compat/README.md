# Zamgune Unity Pipeline Compatibility

An Editor-only package that keeps the InputAction-name based timed-play workflow from
`play_unity_game` while projects move to Unity's official CLI and `com.unity.pipeline`.

## Requirements

- Unity 6 (`6000.0` or newer)
- Unity CLI `1.0.0-beta.2`
- `com.unity.pipeline` `0.3.1-exp.1`
- Input System `1.19.0`

The package has no Python, uv, UniTask, settings asset, or background file watcher.

## Commands

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

## Tests

Package Editor tests live under `Tests/Editor`. Add the package name to the consuming project's
`testables` array when running package tests through Unity Test Framework:

```json
"testables": ["com.zamgune.unity-pipeline-compat"]
```

The Editor tests cover command metadata, structured JSON input, deterministic asset resolution,
simultaneous keyboard state, and residual input reset. A live Unity CLI integration pass is still
required to prove Play Mode transitions, timed game advancement, reconnection, and focus behavior.

See [Documentation~/index.md](Documentation~/index.md) for lifecycle and failure semantics.
