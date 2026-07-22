# Timed play compatibility commands

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
