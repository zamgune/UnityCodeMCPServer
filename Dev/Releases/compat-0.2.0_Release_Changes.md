# Unity Pipeline Compatibility 0.2.0 Release Changes

## Summary

- Unity's official CLI MCP and `com.unity.pipeline` are now the repository's default automation
  path.
- `com.zamgune.unity-pipeline-compat` remains a small Editor-only add-on for deterministic named
  input steps and final-composited Game View capture.
- The compatibility command contract is unchanged from the cross-project validated `0.1.0`
  implementation.
- The published UnityCodeMCPServer executable package and `unity-code-mcp-stdio` remain at `0.7.0`
  for rollback only.

## Versions

- Unity CLI: `1.0.0-beta.2`
- `com.unity.pipeline`: `0.3.1-exp.1`
- `com.zamgune.unity-pipeline-compat`: `0.2.0`
- Input System: `1.19.0`

## Migration boundary

The official CLI/Pipeline supplies Editor status, Console access, `eval`/`eval_file`, tests, Play
control, and camera/Scene captures. The compatibility package supplies only:

- `zamgune_play_begin`
- `zamgune_play_step`
- `zamgune_capture_game_view`
- `zamgune_play_end`

The active official path depends on no Python, uv, UniTask, settings asset, copied stdio bridge, or
background file watcher. This repository still compiles the retained rollback source, so its idle
watcher can exist while developing the repository itself.

Only this repository development project's serialized legacy settings instance is changed: it
redirects generated legacy skills to ignored `Library/LegacyUnityCodeMcpServerSkills`. Legacy
executable C# and Python source is unchanged, and no `stdio-v*` artifact is republished.

## Publication

Use the `compat-v0.2.0` tag for the UPM Git dependency. Publishing the legacy Python bridge under a
`stdio-v*` tag is intentionally outside this release.
