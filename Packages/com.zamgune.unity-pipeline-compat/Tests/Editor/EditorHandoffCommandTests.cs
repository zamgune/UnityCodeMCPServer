using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using Unity.Pipeline.Commands;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public class EditorHandoffCommandTests
    {
        private const string ProjectPath = "/Volumes/Test/Project";
        private const int EditorPid = 4321;

        [TearDown]
        public void TearDown()
        {
            EditorHandoffCommands.ResetTestHooks();
        }

        [Test]
        public void Commands_ExposeMainThreadContractsAndRequiredCloseIdentity()
        {
            MethodInfo status = typeof(EditorHandoffCommands)
                .GetMethod(nameof(EditorHandoffCommands.HandoffStatus));
            MethodInfo close = typeof(EditorHandoffCommands)
                .GetMethod(nameof(EditorHandoffCommands.CloseEditor));

            Assert.That(status, Is.Not.Null);
            Assert.That(status.GetCustomAttribute<CliCommandAttribute>()?.Name,
                Is.EqualTo("zamgune_handoff_status"));
            Assert.That(status.GetCustomAttribute<CliCommandAttribute>()?.MainThreadRequired,
                Is.True);
            Assert.That(close, Is.Not.Null);
            Assert.That(close.GetCustomAttribute<CliCommandAttribute>()?.Name,
                Is.EqualTo("zamgune_editor_close"));
            Assert.That(close.GetCustomAttribute<CliCommandAttribute>()?.MainThreadRequired,
                Is.True);

            ParameterInfo[] parameters = close.GetParameters();
            Assert.That(parameters.Select(parameter => parameter.Name), Is.EqualTo(new[]
            {
                "expectedProjectPath",
                "expectedPid",
                "transitionId"
            }));
            Assert.That(parameters.Select(parameter => parameter.ParameterType), Is.EqualTo(new[]
            {
                typeof(string),
                typeof(int),
                typeof(string)
            }));
            Assert.That(parameters.All(parameter =>
                parameter.GetCustomAttribute<CliArgAttribute>()?.Required == true), Is.True);
        }

        [Test]
        public void HandoffStatus_CleanSavedEditModeProjectCanClose()
        {
            EditorHandoffCommands.CaptureStatus = CleanSnapshot;

            JObject result = EditorHandoffCommands.HandoffStatus();

            Assert.That(result.Value<string>("projectPath"), Is.EqualTo(ProjectPath));
            Assert.That(result.Value<int>("currentPid"), Is.EqualTo(EditorPid));
            Assert.That(result.Value<string>("playMode"), Is.EqualTo("edit_mode"));
            Assert.That(result.Value<int>("sceneCount"), Is.EqualTo(1));
            Assert.That(result.Value<int>("dirtySceneCount"), Is.Zero);
            Assert.That(result.Value<int>("untitledSceneCount"), Is.Zero);
            Assert.That(result.Value<bool>("canClose"), Is.True);
            Assert.That((JArray)result["blockers"], Is.Empty);
            Assert.That(result["prefabStage"]?.Value<bool>("isOpen"), Is.False);
        }

        [TestCase("batch_mode", "batch_mode")]
        [TestCase("compiling", "compiling")]
        [TestCase("updating", "updating")]
        [TestCase("playing", "play_mode")]
        [TestCase("entering_play_mode", "play_mode_transition")]
        [TestCase("dirty_scene", "dirty_scene")]
        [TestCase("untitled_scene", "untitled_scene")]
        [TestCase("prefab_stage", "prefab_stage_open")]
        [TestCase("dirty_prefab_stage", "dirty_prefab_stage")]
        [TestCase("probe_error", "status_probe_error")]
        public void HandoffStatus_KnownUnsafeStateFailsClosed(
            string state,
            string expectedBlocker)
        {
            EditorHandoffSnapshot snapshot = SnapshotWith(state);
            EditorHandoffCommands.CaptureStatus = () => snapshot;

            JObject result = EditorHandoffCommands.HandoffStatus();

            Assert.That(result.Value<bool>("canClose"), Is.False);
            CollectionAssert.Contains(result["blockers"]?.Values<string>(), expectedBlocker);
        }

        [TestCase("batch_mode")]
        [TestCase("compiling")]
        [TestCase("updating")]
        [TestCase("playing")]
        [TestCase("entering_play_mode")]
        [TestCase("dirty_scene")]
        [TestCase("untitled_scene")]
        [TestCase("prefab_stage")]
        [TestCase("dirty_prefab_stage")]
        [TestCase("probe_error")]
        public void CloseEditor_UnsafeStateNeverSchedules(string state)
        {
            int scheduleCount = 0;
            EditorHandoffCommands.CaptureStatus = () => SnapshotWith(state);
            EditorHandoffCommands.ScheduleClose = _ => scheduleCount++;

            JObject result = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-blocked");

            Assert.That(result.Value<string>("status"), Is.EqualTo("blocked"));
            Assert.That(result.Value<bool>("scheduled"), Is.False);
            Assert.That(scheduleCount, Is.Zero);
        }

        [TestCase("/Volumes/Test/Other", EditorPid, "transition", "project_path_mismatch")]
        [TestCase(ProjectPath, 9999, "transition", "pid_mismatch")]
        [TestCase(ProjectPath, 0, "transition", "invalid_expected_pid")]
        [TestCase(ProjectPath, EditorPid, "", "invalid_transition_id")]
        [TestCase("", EditorPid, "transition", "invalid_expected_project_path")]
        public void CloseEditor_IdentityMismatchNeverSchedules(
            string expectedPath,
            int expectedPid,
            string transitionId,
            string expectedBlocker)
        {
            int scheduleCount = 0;
            EditorHandoffCommands.CaptureStatus = CleanSnapshot;
            EditorHandoffCommands.ScheduleClose = _ => scheduleCount++;

            JObject result = EditorHandoffCommands.CloseEditor(
                expectedPath,
                expectedPid,
                transitionId);

            Assert.That(result.Value<string>("status"), Is.EqualTo("blocked"));
            Assert.That(result.Value<bool>("scheduled"), Is.False);
            Assert.That(result.Value<int>("currentPid"), Is.EqualTo(EditorPid));
            CollectionAssert.Contains(result["blockers"]?.Values<string>(), expectedBlocker);
            Assert.That(scheduleCount, Is.Zero);
        }

        [Test]
        public void CloseEditor_CleanExactIdentitySchedulesAndExecutesFileCloseOnce()
        {
            Action pending = null;
            int scheduleCount = 0;
            int closeCount = 0;
            EditorHandoffCommands.CaptureStatus = CleanSnapshot;
            EditorHandoffCommands.ScheduleClose = callback =>
            {
                scheduleCount++;
                pending = callback;
            };
            EditorHandoffCommands.ExecuteCloseMenu = () =>
            {
                closeCount++;
                return true;
            };

            JObject result = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-1");

            Assert.That(result.Value<string>("status"), Is.EqualTo("scheduled"));
            Assert.That(result.Value<bool>("scheduled"), Is.True);
            Assert.That(result.Value<int>("delayMilliseconds"),
                Is.EqualTo(EditorHandoffCommands.CloseDelayMilliseconds));
            Assert.That(result.Value<string>("closeMethod"), Is.EqualTo("File/Close"));
            Assert.That(result.Value<string>("transitionId"), Is.EqualTo("transition-1"));
            Assert.That(result.Value<int>("currentPid"), Is.EqualTo(EditorPid));
            Assert.That(scheduleCount, Is.EqualTo(1));
            Assert.That(closeCount, Is.Zero);

            Assert.That(pending, Is.Not.Null);
            pending();
            Assert.That(closeCount, Is.EqualTo(1));
        }

        [Test]
        public void CloseEditor_SameTransitionIsIdempotentAndDifferentTransitionIsBlocked()
        {
            int scheduleCount = 0;
            EditorHandoffCommands.CaptureStatus = CleanSnapshot;
            EditorHandoffCommands.ScheduleClose = _ => scheduleCount++;

            JObject first = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-1");
            JObject same = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-1");
            JObject other = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-2");

            Assert.That(first.Value<string>("status"), Is.EqualTo("scheduled"));
            Assert.That(same.Value<string>("status"), Is.EqualTo("already_scheduled"));
            Assert.That(same.Value<bool>("scheduled"), Is.True);
            Assert.That(other.Value<string>("status"), Is.EqualTo("blocked"));
            Assert.That(other.Value<bool>("scheduled"), Is.False);
            CollectionAssert.Contains(
                other["blockers"]?.Values<string>(),
                "close_already_scheduled");
            Assert.That(scheduleCount, Is.EqualTo(1));
        }

        [Test]
        public void CloseEditor_SameTransitionRemainsIdempotentIfStateChangesAfterScheduling()
        {
            EditorHandoffSnapshot snapshot = CleanSnapshot();
            int scheduleCount = 0;
            EditorHandoffCommands.CaptureStatus = () => snapshot;
            EditorHandoffCommands.ScheduleClose = _ => scheduleCount++;

            EditorHandoffCommands.CloseEditor(ProjectPath, EditorPid, "transition-1");
            snapshot.Compiling = true;
            JObject retry = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-1");

            Assert.That(retry.Value<string>("status"), Is.EqualTo("already_scheduled"));
            Assert.That(scheduleCount, Is.EqualTo(1));
        }

        [Test]
        public void DelayedSafetyRecheck_CancelsCloseAndAllowsAReplacementRequest()
        {
            EditorHandoffSnapshot snapshot = CleanSnapshot();
            var callbacks = new List<Action>();
            int closeCount = 0;
            var warnings = new List<string>();
            EditorHandoffCommands.CaptureStatus = () => snapshot;
            EditorHandoffCommands.ScheduleClose = callbacks.Add;
            EditorHandoffCommands.ExecuteCloseMenu = () =>
            {
                closeCount++;
                return true;
            };
            EditorHandoffCommands.LogWarning = warnings.Add;

            EditorHandoffCommands.CloseEditor(ProjectPath, EditorPid, "transition-1");
            snapshot.Compiling = true;
            callbacks.Single()();

            Assert.That(closeCount, Is.Zero);
            Assert.That(warnings.Single(), Does.Contain("compiling"));

            snapshot.Compiling = false;
            JObject replacement = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-2");
            Assert.That(replacement.Value<string>("status"), Is.EqualTo("scheduled"));
            Assert.That(callbacks, Has.Count.EqualTo(2));
        }

        [Test]
        public void CloseEditor_ScheduleFailureReturnsErrorAndDoesNotRetainReservation()
        {
            int attempts = 0;
            EditorHandoffCommands.CaptureStatus = CleanSnapshot;
            EditorHandoffCommands.ScheduleClose = _ =>
            {
                attempts++;
                if (attempts == 1)
                {
                    throw new InvalidOperationException("scheduler unavailable");
                }
            };

            JObject failed = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-1");
            JObject retry = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-2");

            Assert.That(failed.Value<string>("status"), Is.EqualTo("error"));
            Assert.That(failed.Value<string>("error"), Does.Contain("scheduler unavailable"));
            Assert.That(retry.Value<string>("status"), Is.EqualTo("scheduled"));
            Assert.That(attempts, Is.EqualTo(2));
        }

        [Test]
        public void DelayedFileCloseRejectionDoesNotRetainReservation()
        {
            var callbacks = new List<Action>();
            var warnings = new List<string>();
            EditorHandoffCommands.CaptureStatus = CleanSnapshot;
            EditorHandoffCommands.ScheduleClose = callbacks.Add;
            EditorHandoffCommands.ExecuteCloseMenu = () => false;
            EditorHandoffCommands.LogWarning = warnings.Add;

            EditorHandoffCommands.CloseEditor(ProjectPath, EditorPid, "transition-1");
            callbacks.Single()();
            JObject retry = EditorHandoffCommands.CloseEditor(
                ProjectPath,
                EditorPid,
                "transition-2");

            Assert.That(warnings.Single(), Does.Contain("File/Close"));
            Assert.That(retry.Value<string>("status"), Is.EqualTo("scheduled"));
        }

        private static EditorHandoffSnapshot CleanSnapshot()
        {
            return new EditorHandoffSnapshot
            {
                ProjectPath = ProjectPath,
                CurrentPid = EditorPid,
                OpenScenes = new[]
                {
                    new EditorHandoffScene
                    {
                        Name = "Main",
                        Path = "Assets/Scenes/Main.unity",
                        IsLoaded = true,
                        IsDirty = false
                    }
                }
            };
        }

        private static EditorHandoffSnapshot SnapshotWith(string state)
        {
            EditorHandoffSnapshot snapshot = CleanSnapshot();
            switch (state)
            {
                case "batch_mode":
                    snapshot.IsBatchMode = true;
                    break;
                case "compiling":
                    snapshot.Compiling = true;
                    break;
                case "updating":
                    snapshot.Updating = true;
                    break;
                case "playing":
                    snapshot.IsPlaying = true;
                    snapshot.IsPlayingOrWillChangePlaymode = true;
                    break;
                case "entering_play_mode":
                    snapshot.IsPlayingOrWillChangePlaymode = true;
                    break;
                case "dirty_scene":
                    snapshot.OpenScenes[0].IsDirty = true;
                    break;
                case "untitled_scene":
                    snapshot.OpenScenes[0].Path = string.Empty;
                    break;
                case "prefab_stage":
                    snapshot.PrefabStageOpen = true;
                    snapshot.PrefabStageAssetPath = "Assets/Prefabs/Test.prefab";
                    break;
                case "dirty_prefab_stage":
                    snapshot.PrefabStageOpen = true;
                    snapshot.PrefabStageAssetPath = "Assets/Prefabs/Test.prefab";
                    snapshot.PrefabStageDirty = true;
                    break;
                case "probe_error":
                    snapshot.ProbeError = "probe failed";
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(state), state, null);
            }

            return snapshot;
        }
    }
}
