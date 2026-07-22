using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Unity.Pipeline.Commands;
using UnityEngine;

namespace Zamgune.UnityPipelineCompat
{
    [Serializable]
    public sealed class ZamgunePlayStepOptions : IStructuredCommandInput
    {
        [CliArg("duration_ms", "Real-time duration in milliseconds to advance the game.", Required = true)]
        [JsonProperty("duration_ms")]
        public int DurationMs { get; set; }

        [CliArg("input_action_asset_path", "Optional Unity asset path to an InputActionAsset.")]
        [JsonProperty("input_action_asset_path")]
        public string InputActionAssetPath { get; set; }

        [CliArg("inputs", "InputAction-name requests to inject for this step.")]
        [JsonProperty("inputs")]
        public List<ZamgunePlayInput> Inputs { get; set; } = new List<ZamgunePlayInput>();
    }

    [Serializable]
    public sealed class ZamgunePlayInput : IStructuredCommandInput
    {
        [CliArg("action", "Exact InputAction name or Map/Action path.", Required = true)]
        [JsonProperty("action")]
        public string Action { get; set; }

        [CliArg("type", "Input behavior: press or hold.", Required = true)]
        [JsonProperty("type")]
        public string Type { get; set; }
    }

    [Serializable]
    public sealed class ZamgunePlayLifecycleResponse
    {
        public bool Success { get; set; }
        public string State { get; set; }
        public string Detail { get; set; }
        public string Error { get; set; }
        public bool IsPlaying { get; set; }
        public float TimeScale { get; set; }

        internal static ZamgunePlayLifecycleResponse Ok(string state, string detail)
        {
            return new ZamgunePlayLifecycleResponse
            {
                Success = true,
                State = state,
                Detail = detail,
                IsPlaying = UnityEditor.EditorApplication.isPlaying,
                TimeScale = Time.timeScale
            };
        }

        internal static ZamgunePlayLifecycleResponse Fail(string state, string error)
        {
            return new ZamgunePlayLifecycleResponse
            {
                Success = false,
                State = state,
                Error = error,
                IsPlaying = UnityEditor.EditorApplication.isPlaying,
                TimeScale = Time.timeScale
            };
        }
    }

    [Serializable]
    public sealed class ZamgunePlayStepResponse
    {
        public bool Success { get; set; }
        public string State { get; set; }
        public string Error { get; set; }
        public int RequestedDurationMs { get; set; }
        public double ElapsedRealtimeMs { get; set; }
        public float TimeScale { get; set; }
        public string InputActionAssetPath { get; set; }
        public string[] AppliedInputs { get; set; } = Array.Empty<string>();
        public string[] Warnings { get; set; } = Array.Empty<string>();
        public ZamgunePlayLogEntry[] Logs { get; set; } = Array.Empty<ZamgunePlayLogEntry>();
    }

    [Serializable]
    public sealed class ZamgunePlayLogEntry
    {
        public string Message { get; set; }
        public string StackTrace { get; set; }
        public string Type { get; set; }
    }

    internal enum ZamgunePlayInputType
    {
        Press,
        Hold
    }
}
