# Changelog

## [0.1.0] - 2026-07-22

- Added `zamgune_play_begin`, `zamgune_play_step`, and `zamgune_play_end` Unity Pipeline commands.
- Added `zamgune_capture_game_view` for final-composited Play Mode PNG capture, including
  `ScreenSpaceOverlay` UI, with bounded polling and proportional height scaling.
- Added structured InputAction-name based `press` and `hold` simulation.
- Added focus bypass, device reset/release, console capture, and time-scale restoration.
- Added Editor tests for capture command metadata, height validation, and scaling, plus migration
  documentation for the capture boundary.
