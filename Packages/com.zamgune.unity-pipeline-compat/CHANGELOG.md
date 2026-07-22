# Changelog

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
