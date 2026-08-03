using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Zamgune.UnityPipelineCompat
{
    /// <summary>
    /// Reports the fail-closed state used by the single-seat Editor handoff queue and schedules a
    /// normal Unity File/Close only when that state is clean. It never saves, discards, stops Play
    /// Mode, or sends a process signal.
    /// </summary>
    public static class EditorHandoffCommands
    {
        internal const int CloseDelayMilliseconds = 750;
        internal const string CloseMenuPath = "File/Close";

        private static readonly object CloseGate = new object();
        private static CloseReservation _reservation;

        internal static Func<EditorHandoffSnapshot> CaptureStatus =
            EditorHandoffStatusProbe.Capture;
        internal static Action<Action> ScheduleClose =
            callback => EditorCloseDelay.Schedule(callback, CloseDelayMilliseconds);
        internal static Func<bool> ExecuteCloseMenu =
            () => EditorApplication.ExecuteMenuItem(CloseMenuPath);
        internal static Action<string> LogWarning = UnityEngine.Debug.LogWarning;

        [CliCommand(
            "zamgune_handoff_status",
            "Inspect whether this Editor can be closed safely for a single-seat project handoff.",
            MainThreadRequired = true)]
        public static JObject HandoffStatus()
        {
            return CaptureSafely().ToJson();
        }

        [CliCommand(
            "zamgune_editor_close",
            "Fail closed on unsafe Editor state, then schedule one normal File/Close after the command response can be delivered.",
            MainThreadRequired = true)]
        public static JObject CloseEditor(
            [CliArg(
                "expectedProjectPath",
                "Exact canonical project path expected by the handoff queue.",
                Required = true)]
            string expectedProjectPath,
            [CliArg(
                "expectedPid",
                "Exact Unity Editor process ID expected by the handoff queue.",
                Required = true)]
            int expectedPid,
            [CliArg(
                "transitionId",
                "Non-empty handoff transition ID used as the idempotency key.",
                Required = true)]
            string transitionId)
        {
            EditorHandoffSnapshot snapshot = CaptureSafely();
            string[] identityBlockers = ValidateIdentity(
                snapshot,
                expectedProjectPath,
                expectedPid,
                transitionId);
            if (identityBlockers.Length > 0)
            {
                return CloseResponse(
                    "blocked",
                    false,
                    snapshot,
                    expectedProjectPath,
                    expectedPid,
                    transitionId,
                    identityBlockers);
            }

            var requestedReservation = new CloseReservation(
                NormalizeProjectPath(expectedProjectPath),
                expectedPid,
                transitionId);
            lock (CloseGate)
            {
                if (_reservation != null)
                {
                    if (_reservation.Matches(requestedReservation))
                    {
                        return CloseResponse(
                            "already_scheduled",
                            true,
                            snapshot,
                            expectedProjectPath,
                            expectedPid,
                            transitionId,
                            Array.Empty<string>());
                    }

                    string blocker = string.Equals(
                        _reservation.TransitionId,
                        transitionId,
                        StringComparison.Ordinal)
                        ? "transition_identity_mismatch"
                        : "close_already_scheduled";
                    return CloseResponse(
                        "blocked",
                        false,
                        snapshot,
                        expectedProjectPath,
                        expectedPid,
                        transitionId,
                        new[] { blocker });
                }

                if (!snapshot.CanClose)
                {
                    return CloseResponse(
                        "blocked",
                        false,
                        snapshot,
                        expectedProjectPath,
                        expectedPid,
                        transitionId,
                        snapshot.Blockers);
                }

                _reservation = requestedReservation;
            }

            try
            {
                ScheduleClose(() => ExecuteScheduledClose(requestedReservation));
                return CloseResponse(
                    "scheduled",
                    true,
                    snapshot,
                    expectedProjectPath,
                    expectedPid,
                    transitionId,
                    Array.Empty<string>());
            }
            catch (Exception exception)
            {
                ClearReservation(requestedReservation);
                return CloseResponse(
                    "error",
                    false,
                    snapshot,
                    expectedProjectPath,
                    expectedPid,
                    transitionId,
                    Array.Empty<string>(),
                    $"Unable to schedule {CloseMenuPath}: {exception.Message}");
            }
        }

        private static void ExecuteScheduledClose(CloseReservation reservation)
        {
            EditorHandoffSnapshot snapshot = CaptureSafely();
            string[] blockers = snapshot.Blockers
                .Concat(ValidateIdentity(
                snapshot,
                reservation.ProjectPath,
                reservation.Pid,
                reservation.TransitionId))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (blockers.Length > 0)
            {
                ClearReservation(reservation);
                LogWarning(
                    "Unity single-seat handoff close was cancelled because the delayed safety " +
                    $"recheck found blockers: {string.Join(", ", blockers)}.");
                return;
            }

            try
            {
                if (!ExecuteCloseMenu())
                {
                    ClearReservation(reservation);
                    LogWarning(
                        $"Unity single-seat handoff could not execute the {CloseMenuPath} menu item.");
                }
            }
            catch (Exception exception)
            {
                ClearReservation(reservation);
                LogWarning(
                    $"Unity single-seat handoff {CloseMenuPath} failed: {exception.Message}");
            }
        }

        private static string[] ValidateIdentity(
            EditorHandoffSnapshot snapshot,
            string expectedProjectPath,
            int expectedPid,
            string transitionId)
        {
            var blockers = new List<string>();
            if (string.IsNullOrWhiteSpace(transitionId))
            {
                blockers.Add("invalid_transition_id");
            }

            if (expectedPid <= 0)
            {
                blockers.Add("invalid_expected_pid");
            }
            else if (expectedPid != snapshot.CurrentPid)
            {
                blockers.Add("pid_mismatch");
            }

            string normalizedExpectedPath = NormalizeProjectPath(expectedProjectPath);
            string normalizedCurrentPath = NormalizeProjectPath(snapshot.ProjectPath);
            if (normalizedExpectedPath == null)
            {
                blockers.Add("invalid_expected_project_path");
            }
            else if (normalizedCurrentPath == null ||
                     !string.Equals(
                         normalizedExpectedPath,
                         normalizedCurrentPath,
                         StringComparison.Ordinal))
            {
                blockers.Add("project_path_mismatch");
            }

            return blockers.Distinct(StringComparer.Ordinal).ToArray();
        }

        private static string NormalizeProjectPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return null;
            }

            try
            {
                string normalized = Path.GetFullPath(path);
                return normalized.Length > 1
                    ? normalized.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    : normalized;
            }
            catch
            {
                return null;
            }
        }

        private static void ClearReservation(CloseReservation reservation)
        {
            lock (CloseGate)
            {
                if (_reservation != null && _reservation.Matches(reservation))
                {
                    _reservation = null;
                }
            }
        }

        private static EditorHandoffSnapshot CaptureSafely()
        {
            try
            {
                EditorHandoffSnapshot snapshot = CaptureStatus();
                return snapshot ?? EditorHandoffSnapshot.ProbeFailure(
                    "The handoff status probe returned no result.");
            }
            catch (Exception exception)
            {
                return EditorHandoffSnapshot.ProbeFailure(
                    $"Unable to inspect Editor handoff state: {exception.Message}");
            }
        }

        private static JObject CloseResponse(
            string status,
            bool scheduled,
            EditorHandoffSnapshot snapshot,
            string expectedProjectPath,
            int expectedPid,
            string transitionId,
            string[] blockers,
            string error = null)
        {
            var result = new JObject
            {
                ["status"] = status,
                ["scheduled"] = scheduled,
                ["delayMilliseconds"] = CloseDelayMilliseconds,
                ["closeMethod"] = CloseMenuPath,
                ["transitionId"] = transitionId == null
                    ? JValue.CreateNull()
                    : new JValue(transitionId),
                ["expectedProjectPath"] = expectedProjectPath == null
                    ? JValue.CreateNull()
                    : new JValue(expectedProjectPath),
                ["expectedPid"] = expectedPid,
                ["currentPid"] = snapshot.CurrentPid,
                ["blockers"] = new JArray(blockers ?? Array.Empty<string>()),
                ["handoffStatus"] = snapshot.ToJson()
            };
            if (!string.IsNullOrEmpty(error))
            {
                result["error"] = error;
            }

            return result;
        }

        internal static void ResetTestHooks()
        {
            CaptureStatus = EditorHandoffStatusProbe.Capture;
            ScheduleClose = callback => EditorCloseDelay.Schedule(callback, CloseDelayMilliseconds);
            ExecuteCloseMenu = () => EditorApplication.ExecuteMenuItem(CloseMenuPath);
            LogWarning = UnityEngine.Debug.LogWarning;
            lock (CloseGate)
            {
                _reservation = null;
            }
        }

        private sealed class CloseReservation
        {
            internal CloseReservation(string projectPath, int pid, string transitionId)
            {
                ProjectPath = projectPath;
                Pid = pid;
                TransitionId = transitionId;
            }

            internal string ProjectPath { get; }
            internal int Pid { get; }
            internal string TransitionId { get; }

            internal bool Matches(CloseReservation other)
            {
                return other != null &&
                       Pid == other.Pid &&
                       string.Equals(ProjectPath, other.ProjectPath, StringComparison.Ordinal) &&
                       string.Equals(TransitionId, other.TransitionId, StringComparison.Ordinal);
            }
        }
    }

    internal static class EditorHandoffStatusProbe
    {
        internal static EditorHandoffSnapshot Capture()
        {
            bool isPlaying = EditorApplication.isPlaying;
            bool isPlayingOrWillChange = EditorApplication.isPlayingOrWillChangePlaymode;
            var scenes = new List<EditorHandoffScene>();
            for (int index = 0; index < SceneManager.sceneCount; index++)
            {
                Scene scene = SceneManager.GetSceneAt(index);
                scenes.Add(new EditorHandoffScene
                {
                    Name = scene.name ?? string.Empty,
                    Path = scene.path ?? string.Empty,
                    IsLoaded = scene.isLoaded,
                    IsDirty = scene.isDirty
                });
            }

            PrefabStage prefabStage = PrefabStageUtility.GetCurrentPrefabStage();
            return new EditorHandoffSnapshot
            {
                ProjectPath = Path.GetFullPath(Path.Combine(Application.dataPath, "..")),
                CurrentPid = Process.GetCurrentProcess().Id,
                IsBatchMode = Application.isBatchMode,
                Compiling = EditorApplication.isCompiling,
                Updating = EditorApplication.isUpdating,
                IsPlaying = isPlaying,
                IsPlayingOrWillChangePlaymode = isPlayingOrWillChange,
                IsPaused = EditorApplication.isPaused,
                OpenScenes = scenes.ToArray(),
                PrefabStageOpen = prefabStage != null,
                PrefabStageAssetPath = prefabStage?.assetPath,
                PrefabStageDirty = prefabStage != null && prefabStage.scene.isDirty
            };
        }
    }

    internal sealed class EditorHandoffSnapshot
    {
        internal string ProjectPath { get; set; } = string.Empty;
        internal int CurrentPid { get; set; }
        internal bool IsBatchMode { get; set; }
        internal bool Compiling { get; set; }
        internal bool Updating { get; set; }
        internal bool IsPlaying { get; set; }
        internal bool IsPlayingOrWillChangePlaymode { get; set; }
        internal bool IsPaused { get; set; }
        internal EditorHandoffScene[] OpenScenes { get; set; } = Array.Empty<EditorHandoffScene>();
        internal bool PrefabStageOpen { get; set; }
        internal string PrefabStageAssetPath { get; set; }
        internal bool PrefabStageDirty { get; set; }
        internal string ProbeError { get; set; }

        internal int DirtySceneCount => OpenScenes.Count(scene => scene.IsDirty);
        internal int UntitledSceneCount => OpenScenes.Count(scene => scene.IsUntitled);

        internal string PlayMode
        {
            get
            {
                if (IsPlaying && !IsPlayingOrWillChangePlaymode)
                {
                    return "exiting_play_mode";
                }

                if (!IsPlaying && IsPlayingOrWillChangePlaymode)
                {
                    return "entering_play_mode";
                }

                return IsPlaying ? "playing" : "edit_mode";
            }
        }

        internal string[] Blockers
        {
            get
            {
                var blockers = new List<string>();
                if (!string.IsNullOrEmpty(ProbeError))
                {
                    blockers.Add("status_probe_error");
                }

                if (IsBatchMode)
                {
                    blockers.Add("batch_mode");
                }

                if (Compiling)
                {
                    blockers.Add("compiling");
                }

                if (Updating)
                {
                    blockers.Add("updating");
                }

                if (IsPlaying)
                {
                    blockers.Add("play_mode");
                }

                if (IsPlaying != IsPlayingOrWillChangePlaymode)
                {
                    blockers.Add("play_mode_transition");
                }

                if (DirtySceneCount > 0)
                {
                    blockers.Add("dirty_scene");
                }

                if (UntitledSceneCount > 0)
                {
                    blockers.Add("untitled_scene");
                }

                if (PrefabStageOpen)
                {
                    blockers.Add("prefab_stage_open");
                }

                if (PrefabStageDirty)
                {
                    blockers.Add("dirty_prefab_stage");
                }

                return blockers.ToArray();
            }
        }

        internal bool CanClose => Blockers.Length == 0;

        internal JObject ToJson()
        {
            var scenes = new JArray(OpenScenes.Select(scene => scene.ToJson()));
            var result = new JObject
            {
                ["projectPath"] = ProjectPath,
                ["currentPid"] = CurrentPid,
                ["isBatchMode"] = IsBatchMode,
                ["compiling"] = Compiling,
                ["updating"] = Updating,
                ["playMode"] = PlayMode,
                ["isPlaying"] = IsPlaying,
                ["isPlayingOrWillChangePlaymode"] = IsPlayingOrWillChangePlaymode,
                ["isPaused"] = IsPaused,
                ["openScenes"] = scenes,
                ["sceneCount"] = scenes.Count,
                ["dirtySceneCount"] = DirtySceneCount,
                ["untitledSceneCount"] = UntitledSceneCount,
                ["prefabStage"] = new JObject
                {
                    ["isOpen"] = PrefabStageOpen,
                    ["assetPath"] = PrefabStageAssetPath == null
                        ? JValue.CreateNull()
                        : new JValue(PrefabStageAssetPath),
                    ["isDirty"] = PrefabStageDirty
                },
                ["canClose"] = CanClose,
                ["blockers"] = new JArray(Blockers)
            };
            if (!string.IsNullOrEmpty(ProbeError))
            {
                result["error"] = ProbeError;
            }

            return result;
        }

        internal static EditorHandoffSnapshot ProbeFailure(string error)
        {
            return new EditorHandoffSnapshot
            {
                ProjectPath = TryGetProjectPath(),
                CurrentPid = TryGetCurrentPid(),
                ProbeError = error
            };
        }

        private static string TryGetProjectPath()
        {
            try
            {
                return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            }
            catch
            {
                return string.Empty;
            }
        }

        private static int TryGetCurrentPid()
        {
            try
            {
                return Process.GetCurrentProcess().Id;
            }
            catch
            {
                return 0;
            }
        }
    }

    internal sealed class EditorHandoffScene
    {
        internal string Name { get; set; } = string.Empty;
        internal string Path { get; set; } = string.Empty;
        internal bool IsLoaded { get; set; }
        internal bool IsDirty { get; set; }
        internal bool IsUntitled => string.IsNullOrEmpty(Path);

        internal JObject ToJson()
        {
            return new JObject
            {
                ["name"] = Name,
                ["path"] = Path,
                ["isLoaded"] = IsLoaded,
                ["isDirty"] = IsDirty,
                ["isUntitled"] = IsUntitled
            };
        }
    }

    internal static class EditorCloseDelay
    {
        private static Action _pending;
        private static double _dueAt;

        internal static void Schedule(Action callback, int delayMilliseconds)
        {
            if (callback == null)
            {
                throw new ArgumentNullException(nameof(callback));
            }

            if (_pending != null)
            {
                throw new InvalidOperationException("An Editor close callback is already pending.");
            }

            _pending = callback;
            _dueAt = EditorApplication.timeSinceStartup + (delayMilliseconds / 1000d);
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;
        }

        private static void OnEditorUpdate()
        {
            if (_pending == null || EditorApplication.timeSinceStartup < _dueAt)
            {
                return;
            }

            Action callback = _pending;
            _pending = null;
            EditorApplication.update -= OnEditorUpdate;
            callback();
        }
    }
}
