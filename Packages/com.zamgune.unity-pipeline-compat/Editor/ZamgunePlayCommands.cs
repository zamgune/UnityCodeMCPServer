using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEngine;
using UnityEngine.InputSystem;

namespace Zamgune.UnityPipelineCompat
{
    [InitializeOnLoad]
    public static class ZamgunePlayCommands
    {
        private const string SessionPrefix = "com.zamgune.unity-pipeline-compat.";
        private const string ActiveKey = SessionPrefix + "active";
        private const string BeginPendingKey = SessionPrefix + "begin-pending";
        private const string HasOriginalTimeScaleKey = SessionPrefix + "has-original-time-scale";
        private const string OriginalTimeScaleKey = SessionPrefix + "original-time-scale";
        internal const int MaxDurationMs = 300000;

        private static bool _step_in_progress;

        static ZamgunePlayCommands()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            EditorApplication.delayCall += ReconcileAfterDomainReload;
        }

        [CliCommand(
            "zamgune_play_begin",
            "Enter Editor Play Mode and establish a timed-play session paused at Time.timeScale=0.",
            MainThreadRequired = true)]
        public static ZamgunePlayLifecycleResponse Begin()
        {
            if (_step_in_progress)
            {
                return ZamgunePlayLifecycleResponse.Fail(
                    "busy",
                    "A zamgune_play_step command is already running.");
            }

            RecordOriginalTimeScaleIfNeeded();
            SessionState.SetBool(ActiveKey, true);

            if (EditorApplication.isPlaying)
            {
                SessionState.SetBool(BeginPendingKey, false);
                EditorApplication.isPaused = false;
                Time.timeScale = 0f;
                PlayInputDriver.ResetEveryInputDevice();
                return ZamgunePlayLifecycleResponse.Ok(
                    "playing_paused",
                    "The Editor was already in Play Mode and is now paused with Time.timeScale=0.");
            }

            SessionState.SetBool(BeginPendingKey, true);
            EditorApplication.isPlaying = true;
            return ZamgunePlayLifecycleResponse.Ok(
                "entering_play_mode",
                "Play Mode was requested. Reconnect after any domain reload, then check editor_status before stepping.");
        }

        [CliCommand(
            "zamgune_play_step",
            "Advance a running Editor game for a real-time duration while injecting InputAction-name press/hold inputs.",
            MainThreadRequired = true)]
        public static async Task<ZamgunePlayStepResponse> Step(
            [CliArg("options", "Timed play options.", Required = true)] ZamgunePlayStepOptions options)
        {
            string validationError = ValidateOptions(options);
            if (!string.IsNullOrEmpty(validationError))
            {
                return FailureResponse(options, "invalid_request", validationError);
            }

            if (!EditorApplication.isPlaying)
            {
                return FailureResponse(
                    options,
                    "not_playing",
                    "Unity is not in Play Mode. Call zamgune_play_begin and wait for editor_status first.");
            }

            if (_step_in_progress)
            {
                return FailureResponse(options, "busy", "Another zamgune_play_step command is already running.");
            }

            _step_in_progress = true;
            RecordOriginalTimeScaleIfNeeded();
            SessionState.SetBool(ActiveKey, true);
            SessionState.SetBool(BeginPendingKey, false);

            bool previousEditorPaused = EditorApplication.isPaused;
            string resolvedAssetPath = null;
            string failure = null;
            var warnings = new List<string>();
            ZamgunePlayLogEntry[] logs = Array.Empty<ZamgunePlayLogEntry>();
            PlayInputDriver inputDriver = null;
            var stopwatch = Stopwatch.StartNew();

            using (var logCapture = new StepLogCapture())
            {
                logCapture.Start();
                try
                {
                    IReadOnlyList<ZamgunePlayInput> inputs = options.Inputs != null
                        ? options.Inputs
                        : Array.Empty<ZamgunePlayInput>();
                    InputActionAsset inputAsset = null;
                    if (RequiresInputActionAsset(options))
                    {
                        inputAsset = InputActionAssetResolver.Load(
                            options.InputActionAssetPath,
                            out resolvedAssetPath,
                            out string resolverWarning);
                        if (!string.IsNullOrEmpty(resolverWarning))
                        {
                            warnings.Add(resolverWarning);
                        }
                    }

                    inputDriver = new PlayInputDriver();
                    inputDriver.Prepare();

                    EditorApplication.isPaused = false;
                    Time.timeScale = 1f;
                    inputDriver.TriggerInputs(inputAsset, inputs);

                    double deadline = EditorApplication.timeSinceStartup + (options.DurationMs / 1000d);
                    bool pressInputsReleased = !inputDriver.HasPressInputs;

                    while (EditorApplication.timeSinceStartup < deadline)
                    {
                        await NextEditorUpdateAsync();
                        if (!EditorApplication.isPlaying)
                        {
                            throw new InvalidOperationException("The Editor left Play Mode during the timed step.");
                        }

                        if (!pressInputsReleased)
                        {
                            inputDriver.ReleasePressInputs();
                            pressInputsReleased = true;
                        }

                        inputDriver.RefreshHeldInputs();
                    }

                    if (!pressInputsReleased)
                    {
                        inputDriver.ReleasePressInputs();
                    }
                }
                catch (Exception ex)
                {
                    failure = ex.Message;
                }
                finally
                {
                    try
                    {
                        inputDriver?.Dispose();
                        if (inputDriver != null)
                        {
                            warnings.AddRange(inputDriver.Warnings);
                        }
                    }
                    catch (Exception cleanupException)
                    {
                        string cleanupMessage = $"Input cleanup failed: {cleanupException.Message}";
                        warnings.Add(cleanupMessage);
                        failure = string.IsNullOrEmpty(failure)
                            ? cleanupMessage
                            : $"{failure} {cleanupMessage}";
                    }

                    if (EditorApplication.isPlaying)
                    {
                        Time.timeScale = 0f;
                        EditorApplication.isPaused = previousEditorPaused;
                    }
                    else
                    {
                        RestoreOriginalTimeScale();
                    }

                    stopwatch.Stop();
                    logs = logCapture.Snapshot();
                    _step_in_progress = false;
                }
            }

            return new ZamgunePlayStepResponse
            {
                Success = string.IsNullOrEmpty(failure),
                State = string.IsNullOrEmpty(failure) ? "playing_paused" : "step_failed",
                Error = failure,
                RequestedDurationMs = options.DurationMs,
                ElapsedRealtimeMs = Math.Round(stopwatch.Elapsed.TotalMilliseconds, 3),
                TimeScale = Time.timeScale,
                InputActionAssetPath = resolvedAssetPath,
                AppliedInputs = inputDriver?.AppliedInputs.ToArray() ?? Array.Empty<string>(),
                Warnings = warnings.Distinct().ToArray(),
                Logs = logs
            };
        }

        [CliCommand(
            "zamgune_play_end",
            "Release injected input, restore the pre-session time scale, and leave Editor Play Mode.",
            MainThreadRequired = true)]
        public static ZamgunePlayLifecycleResponse End()
        {
            if (_step_in_progress)
            {
                return ZamgunePlayLifecycleResponse.Fail(
                    "busy",
                    "A zamgune_play_step command is still running; wait for it to finish before ending the session.");
            }

            PlayInputDriver.ResetEveryInputDevice();
            RestoreOriginalTimeScale();
            EditorApplication.isPaused = false;
            ClearSessionState();

            if (!EditorApplication.isPlaying)
            {
                return ZamgunePlayLifecycleResponse.Ok(
                    "edit_mode",
                    "The Editor was already in Edit Mode; compatibility session state was cleared.");
            }

            EditorApplication.isPlaying = false;
            return ZamgunePlayLifecycleResponse.Ok(
                "exiting_play_mode",
                "Edit Mode was requested and the original time scale was restored.");
        }

        internal static string ValidateOptions(ZamgunePlayStepOptions options)
        {
            if (options == null)
            {
                return "The structured 'options' argument is required.";
            }

            if (options.DurationMs < 0)
            {
                return "duration_ms must be zero or greater.";
            }

            if (options.DurationMs > MaxDurationMs)
            {
                return $"duration_ms must not exceed {MaxDurationMs}.";
            }

            if (options.Inputs == null)
            {
                return null;
            }

            for (int i = 0; i < options.Inputs.Count; i++)
            {
                ZamgunePlayInput input = options.Inputs[i];
                if (input == null)
                {
                    return $"inputs[{i}] must be an object.";
                }

                if (string.IsNullOrWhiteSpace(input.Action))
                {
                    return $"inputs[{i}].action cannot be empty.";
                }

                if (!PlayInputDriver.TryParseInputType(input.Type, out _))
                {
                    return $"inputs[{i}].type must be 'press' or 'hold'.";
                }
            }

            return null;
        }

        internal static bool RequiresInputActionAsset(ZamgunePlayStepOptions options)
        {
            return options?.Inputs != null && options.Inputs.Count > 0;
        }

        private static Task NextEditorUpdateAsync()
        {
            var completion = new TaskCompletionSource<bool>();
            EditorApplication.CallbackFunction callback = null;
            callback = () =>
            {
                EditorApplication.update -= callback;
                completion.TrySetResult(true);
            };
            EditorApplication.update += callback;
            return completion.Task;
        }

        private static ZamgunePlayStepResponse FailureResponse(
            ZamgunePlayStepOptions options,
            string state,
            string error)
        {
            return new ZamgunePlayStepResponse
            {
                Success = false,
                State = state,
                Error = error,
                RequestedDurationMs = options?.DurationMs ?? 0,
                TimeScale = Time.timeScale
            };
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            switch (state)
            {
                case PlayModeStateChange.EnteredPlayMode:
                    if (SessionState.GetBool(ActiveKey, false) ||
                        SessionState.GetBool(BeginPendingKey, false))
                    {
                        SessionState.SetBool(ActiveKey, true);
                        SessionState.SetBool(BeginPendingKey, false);
                        EditorApplication.isPaused = false;
                        Time.timeScale = 0f;
                        PlayInputDriver.ResetEveryInputDevice();
                    }
                    break;

                case PlayModeStateChange.ExitingPlayMode:
                    if (SessionState.GetBool(ActiveKey, false))
                    {
                        PlayInputDriver.ResetEveryInputDevice();
                        RestoreOriginalTimeScale();
                    }
                    break;

                case PlayModeStateChange.EnteredEditMode:
                    if (SessionState.GetBool(ActiveKey, false) ||
                        SessionState.GetBool(BeginPendingKey, false))
                    {
                        RestoreOriginalTimeScale();
                        ClearSessionState();
                    }
                    break;
            }
        }

        private static void ReconcileAfterDomainReload()
        {
            if (EditorApplication.isPlaying && SessionState.GetBool(ActiveKey, false))
            {
                SessionState.SetBool(BeginPendingKey, false);
                EditorApplication.isPaused = false;
                Time.timeScale = 0f;
                PlayInputDriver.ResetEveryInputDevice();
                return;
            }

            if (!EditorApplication.isPlaying &&
                !EditorApplication.isPlayingOrWillChangePlaymode &&
                SessionState.GetBool(BeginPendingKey, false))
            {
                RestoreOriginalTimeScale();
                ClearSessionState();
            }
        }

        private static void RecordOriginalTimeScaleIfNeeded()
        {
            if (SessionState.GetBool(HasOriginalTimeScaleKey, false))
            {
                return;
            }

            SessionState.SetFloat(OriginalTimeScaleKey, Time.timeScale);
            SessionState.SetBool(HasOriginalTimeScaleKey, true);
        }

        private static void RestoreOriginalTimeScale()
        {
            if (SessionState.GetBool(HasOriginalTimeScaleKey, false))
            {
                Time.timeScale = SessionState.GetFloat(OriginalTimeScaleKey, 1f);
            }
        }

        private static void ClearSessionState()
        {
            SessionState.SetBool(ActiveKey, false);
            SessionState.SetBool(BeginPendingKey, false);
            SessionState.SetBool(HasOriginalTimeScaleKey, false);
        }
    }
}
