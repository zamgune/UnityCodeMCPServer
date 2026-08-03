using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Unity.Pipeline.Commands;
using Unity.Pipeline.Editor;
using UnityEditor;
using UnityEngine;

namespace Zamgune.UnityPipelineCompat
{
    /// <summary>
    /// Replaces exactly Pipeline 0.4's JSON-string recompile_status and test_status methods during
    /// command discovery, while preserving one official trigger for each operation. Any unexpected
    /// duplicate or upstream identity change disables all four protected commands instead of
    /// exposing an ambiguous or transport-incompatible contract.
    /// </summary>
    internal sealed class RecompileStatusCompatDiscovery : ICommandDiscovery
    {
        internal const string RecompileCommandName = "recompile";
        internal const string StatusCommandName = "recompile_status";
        internal const string RunTestsCommandName = "run_tests";
        internal const string TestStatusCommandName = "test_status";
        internal const string OfficialTypeName = "Unity.Pipeline.Editor.Commands.RecompileCommand";
        internal const string OfficialRecompileMethodName = "Recompile";
        internal const string OfficialStatusMethodName = "RecompileStatus";
        internal const string OfficialTestTypeName = "Unity.Pipeline.Editor.Commands.TestCommands";
        internal const string OfficialRunTestsMethodName = "RunTests";
        internal const string OfficialTestStatusMethodName = "GetTestStatus";

        private readonly ICommandDiscovery _inner;

        internal RecompileStatusCompatDiscovery(ICommandDiscovery inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        internal bool InvariantEvaluated { get; private set; }
        internal bool InvariantSatisfied { get; private set; }
        internal string InvariantError { get; private set; }

        public IEnumerable<MethodInfo> GetMethodsWithAttribute<T>() where T : Attribute
        {
            List<MethodInfo> methods = _inner.GetMethodsWithAttribute<T>().ToList();
            if (typeof(T) != typeof(CliCommandAttribute))
            {
                return methods;
            }

            List<MethodInfo> officialRecompileMethods = methods
                .Where(IsOfficialRecompileMethod)
                .ToList();
            List<MethodInfo> officialStatusMethods = methods
                .Where(IsOfficialStatusMethod)
                .ToList();
            List<MethodInfo> compatRecompileMethods = methods
                .Where(IsCompatRecompileMethod)
                .ToList();
            List<MethodInfo> compatStatusMethods = methods
                .Where(IsCompatStatusMethod)
                .ToList();
            List<MethodInfo> officialRunTestsMethods = methods
                .Where(IsOfficialRunTestsMethod)
                .ToList();
            List<MethodInfo> officialTestStatusMethods = methods
                .Where(IsOfficialTestStatusMethod)
                .ToList();
            List<MethodInfo> compatTestStatusMethods = methods
                .Where(IsCompatTestStatusMethod)
                .ToList();
            List<MethodInfo> recompileMethods = methods.Where(HasRecompileName).ToList();
            List<MethodInfo> statusMethods = methods.Where(HasRecompileStatusName).ToList();
            List<MethodInfo> runTestsMethods = methods.Where(HasRunTestsName).ToList();
            List<MethodInfo> testStatusMethods = methods.Where(HasTestStatusName).ToList();

            InvariantEvaluated = true;
            InvariantSatisfied = officialRecompileMethods.Count == 1 &&
                                 officialStatusMethods.Count == 1 &&
                                 compatRecompileMethods.Count == 1 &&
                                 compatStatusMethods.Count == 1 &&
                                 officialRunTestsMethods.Count == 1 &&
                                 officialTestStatusMethods.Count == 1 &&
                                 compatTestStatusMethods.Count == 1 &&
                                 recompileMethods.Count == 2 &&
                                 statusMethods.Count == 2 &&
                                 runTestsMethods.Count == 1 &&
                                 testStatusMethods.Count == 2 &&
                                 HasRecompileName(officialRecompileMethods[0]) &&
                                 HasRecompileName(compatRecompileMethods[0]) &&
                                 HasRecompileStatusName(officialStatusMethods[0]) &&
                                 HasRecompileStatusName(compatStatusMethods[0]) &&
                                 HasRunTestsName(officialRunTestsMethods[0]) &&
                                 HasTestStatusName(officialTestStatusMethods[0]) &&
                                 HasTestStatusName(compatTestStatusMethods[0]);

            if (!InvariantSatisfied)
            {
                InvariantError =
                    "Expected exact Pipeline 0.4 trigger/status contracts; found " +
                    $"recompile official={officialRecompileMethods.Count}, " +
                    $"compat={compatRecompileMethods.Count}, total={recompileMethods.Count}; " +
                    $"status official={officialStatusMethods.Count}, compat={compatStatusMethods.Count}, " +
                    $"total={statusMethods.Count}; run_tests official={officialRunTestsMethods.Count}, " +
                    $"total={runTestsMethods.Count}; test_status official={officialTestStatusMethods.Count}, " +
                    $"compat={compatTestStatusMethods.Count}, total={testStatusMethods.Count}.";
                return methods.Where(method => !HasProtectedCommandName(method)).ToArray();
            }

            InvariantError = null;
            return methods
                .Where(method => !IsOfficialRecompileMethod(method) &&
                                 !IsOfficialStatusMethod(method) &&
                                 !IsOfficialTestStatusMethod(method))
                .ToArray();
        }

        internal static bool IsOfficialRecompileMethod(MethodInfo method)
        {
            return method?.DeclaringType?.FullName == OfficialTypeName &&
                   method.Name == OfficialRecompileMethodName;
        }

        internal static bool IsOfficialStatusMethod(MethodInfo method)
        {
            return method?.DeclaringType?.FullName == OfficialTypeName &&
                   method.Name == OfficialStatusMethodName;
        }

        internal static bool IsCompatRecompileMethod(MethodInfo method)
        {
            return method?.DeclaringType == typeof(RecompileCompatCommand) &&
                   method.Name == nameof(RecompileCompatCommand.Recompile);
        }

        internal static bool IsCompatStatusMethod(MethodInfo method)
        {
            return method?.DeclaringType == typeof(RecompileStatusCompatCommand) &&
                   method.Name == nameof(RecompileStatusCompatCommand.RecompileStatus);
        }

        internal static bool IsOfficialRunTestsMethod(MethodInfo method)
        {
            return method?.DeclaringType?.FullName == OfficialTestTypeName &&
                   method.Name == OfficialRunTestsMethodName;
        }

        internal static bool IsOfficialTestStatusMethod(MethodInfo method)
        {
            return method?.DeclaringType?.FullName == OfficialTestTypeName &&
                   method.Name == OfficialTestStatusMethodName;
        }

        internal static bool IsCompatTestStatusMethod(MethodInfo method)
        {
            return method?.DeclaringType == typeof(TestStatusCompatCommand) &&
                   method.Name == nameof(TestStatusCompatCommand.GetTestStatus);
        }

        internal static bool HasRecompileName(MethodInfo method)
        {
            return method?.GetCustomAttribute<CliCommandAttribute>()?.Name == RecompileCommandName;
        }

        internal static bool HasRecompileStatusName(MethodInfo method)
        {
            return method?.GetCustomAttribute<CliCommandAttribute>()?.Name == StatusCommandName;
        }

        internal static bool HasRunTestsName(MethodInfo method)
        {
            return method?.GetCustomAttribute<CliCommandAttribute>()?.Name == RunTestsCommandName;
        }

        internal static bool HasTestStatusName(MethodInfo method)
        {
            return method?.GetCustomAttribute<CliCommandAttribute>()?.Name == TestStatusCommandName;
        }

        internal static bool HasProtectedRecompileName(MethodInfo method)
        {
            return HasRecompileName(method) || HasRecompileStatusName(method);
        }

        internal static bool HasProtectedCommandName(MethodInfo method)
        {
            return HasProtectedRecompileName(method) ||
                   HasRunTestsName(method) ||
                   HasTestStatusName(method);
        }
    }

    internal static class RecompileStatusCompatStartupGate
    {
        internal static bool TryValidateSettingsAsset(out string error)
        {
            return TryValidateSettingsAsset(out _, out error);
        }

        internal static bool TryValidateSettingsAsset(
            out string[] discoveredSettingsPaths,
            out string error)
        {
            string[] guids = AssetDatabase.FindAssets("t:EditorPipelineManager");
            discoveredSettingsPaths = guids
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(path => !string.IsNullOrEmpty(path))
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToArray();

            if (guids.Length != 1)
            {
                string paths = string.Join(", ", discoveredSettingsPaths);
                error =
                    "Expected exactly one EditorPipelineManager settings asset with AutoStart=false; " +
                    $"found {guids.Length}{(paths.Length == 0 ? string.Empty : $" ({paths})")}.";
                return false;
            }

            string path = AssetDatabase.GUIDToAssetPath(guids[0]);
            EditorPipelineManager manager = AssetDatabase.LoadAssetAtPath<EditorPipelineManager>(path);
            if (manager == null)
            {
                error = $"Unable to load the EditorPipelineManager settings asset at {path}.";
                return false;
            }

            if (manager.AutoStart)
            {
                error = $"EditorPipelineManager at {path} must have AutoStart disabled.";
                return false;
            }

            error = null;
            return true;
        }

        internal static bool TryValidateDiscoveryPostcondition(
            RecompileStatusCompatDiscovery discovery,
            IEnumerable<CommandInfo> commands,
            out string error)
        {
            if (discovery == null)
            {
                error = "Compatibility discovery was null.";
                return false;
            }

            if (!discovery.InvariantEvaluated || !discovery.InvariantSatisfied)
            {
                error = discovery.InvariantError ?? "Compatibility discovery invariant was not evaluated.";
                return false;
            }

            if (commands == null)
            {
                error = "Command discovery returned null.";
                return false;
            }

            CommandInfo[] recompileCommands = commands
                .Where(command => command?.Name == RecompileStatusCompatDiscovery.RecompileCommandName)
                .ToArray();
            CommandInfo[] statusCommands = commands
                .Where(command => command?.Name == RecompileStatusCompatDiscovery.StatusCommandName)
                .ToArray();
            CommandInfo[] runTestsCommands = commands
                .Where(command => command?.Name == RecompileStatusCompatDiscovery.RunTestsCommandName)
                .ToArray();
            CommandInfo[] testStatusCommands = commands
                .Where(command => command?.Name == RecompileStatusCompatDiscovery.TestStatusCommandName)
                .ToArray();

            if (recompileCommands.Length != 1 ||
                statusCommands.Length != 1 ||
                runTestsCommands.Length != 1 ||
                testStatusCommands.Length != 1)
            {
                error =
                    $"Postcondition found {recompileCommands.Length} registered " +
                    $"'{RecompileStatusCompatDiscovery.RecompileCommandName}' commands and " +
                    $"{statusCommands.Length} registered " +
                    $"'{RecompileStatusCompatDiscovery.StatusCommandName}' commands; " +
                    $"{runTestsCommands.Length} registered " +
                    $"'{RecompileStatusCompatDiscovery.RunTestsCommandName}' commands and " +
                    $"{testStatusCommands.Length} registered " +
                    $"'{RecompileStatusCompatDiscovery.TestStatusCommandName}' commands.";
                return false;
            }

            if (!RecompileStatusCompatDiscovery.IsCompatRecompileMethod(recompileCommands[0].Method))
            {
                error =
                    $"The registered '{RecompileStatusCompatDiscovery.RecompileCommandName}' command did " +
                    "not resolve to the compatibility method.";
                return false;
            }

            if (!RecompileStatusCompatDiscovery.IsCompatStatusMethod(statusCommands[0].Method))
            {
                error =
                    $"The registered '{RecompileStatusCompatDiscovery.StatusCommandName}' command did not " +
                    "resolve to the compatibility method.";
                return false;
            }

            if (!RecompileStatusCompatDiscovery.IsOfficialRunTestsMethod(runTestsCommands[0].Method))
            {
                error =
                    $"The registered '{RecompileStatusCompatDiscovery.RunTestsCommandName}' command did not " +
                    "resolve to the official Pipeline 0.4 method.";
                return false;
            }

            if (!RecompileStatusCompatDiscovery.IsCompatTestStatusMethod(testStatusCommands[0].Method))
            {
                error =
                    $"The registered '{RecompileStatusCompatDiscovery.TestStatusCommandName}' command did not " +
                    "resolve to the compatibility method.";
                return false;
            }

            error = null;
            return true;
        }
    }

    internal enum RecompileStatusCompatBootstrapState
    {
        Uninitialized,
        DisabledAwaitingImport,
        RunningCompat
    }

    internal static class RecompileStatusCompatBootstrapPolicy
    {
        internal const string CanonicalSettingsPath =
            "Assets/Settings/Pipeline/EditorPipelineManager.asset";

        internal static bool ShouldRunPhaseB(
            RecompileStatusCompatBootstrapState state,
            bool didDomainReload,
            bool hasEditorPipelineManagerEvent,
            bool hasKnownSettingsPathEvent)
        {
            return state != RecompileStatusCompatBootstrapState.Uninitialized &&
                   (didDomainReload ||
                    hasEditorPipelineManagerEvent ||
                    hasKnownSettingsPathEvent);
        }

        internal static bool AnyChangedPathCoversProtectedPath(
            IEnumerable<string> changedPaths,
            IEnumerable<string> protectedPaths)
        {
            if (changedPaths == null || protectedPaths == null)
            {
                return false;
            }

            string[] normalizedProtectedPaths = protectedPaths
                .Select(NormalizeAssetPath)
                .Where(path => !string.IsNullOrEmpty(path))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            return normalizedProtectedPaths.Length > 0 && changedPaths.Any(
                changedPath => normalizedProtectedPaths.Any(
                    protectedPath => IsSameOrAncestorPath(changedPath, protectedPath)));
        }

        internal static bool IsSameOrAncestorPath(string possibleAncestor, string path)
        {
            string normalizedAncestor = NormalizeAssetPath(possibleAncestor);
            string normalizedPath = NormalizeAssetPath(path);
            if (string.IsNullOrEmpty(normalizedAncestor) || string.IsNullOrEmpty(normalizedPath))
            {
                return false;
            }

            return string.Equals(normalizedAncestor, normalizedPath, StringComparison.Ordinal) ||
                   normalizedPath.StartsWith(normalizedAncestor + "/", StringComparison.Ordinal);
        }

        internal static bool IsRelevantObjectPropertyChange(
            bool isChangeAssetObjectProperties,
            bool instanceIsEditorPipelineManager,
            bool guidMatchesKnownSettings,
            bool guidResolvesToEditorPipelineManager)
        {
            return isChangeAssetObjectProperties &&
                   (instanceIsEditorPipelineManager ||
                    guidMatchesKnownSettings ||
                    guidResolvesToEditorPipelineManager);
        }

        internal static bool IsImportedOrMovedManagerFolder(
            bool isFolder,
            int containedEditorPipelineManagerCount)
        {
            return isFolder && containedEditorPipelineManagerCount > 0;
        }

        internal static bool IsCanonicalSettingsPath(string path)
        {
            return string.Equals(path, CanonicalSettingsPath, StringComparison.Ordinal);
        }

        internal static bool IsAssetPath(string path)
        {
            return !string.IsNullOrEmpty(path) &&
                   path.EndsWith(".asset", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeAssetPath(string path)
        {
            return string.IsNullOrEmpty(path)
                ? string.Empty
                : path.Replace('\\', '/').TrimEnd('/');
        }
    }

    [InitializeOnLoad]
    internal static class RecompileStatusCompatInstaller
    {
        private static readonly HashSet<string> KnownSettingsPaths =
            new HashSet<string>(StringComparer.Ordinal);
        private static readonly HashSet<string> KnownSettingsGuids =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private static RecompileStatusCompatBootstrapState s_State =
            RecompileStatusCompatBootstrapState.Uninitialized;
        private static bool s_PhaseBInProgress;
        private static string s_LastPhaseBFailure;

        static RecompileStatusCompatInstaller()
        {
            if (AssetDatabase.IsAssetImportWorkerProcess())
            {
                return;
            }

            CompletePhaseA();
            ObjectChangeEvents.changesPublished -= OnObjectChangesPublished;
            ObjectChangeEvents.changesPublished += OnObjectChangesPublished;
        }

        internal static void OnAssetsPostprocessed(
            string[] importedAssets,
            string[] deletedAssets,
            string[] movedAssets,
            string[] movedFromAssetPaths,
            bool didDomainReload)
        {
            if (AssetDatabase.IsAssetImportWorkerProcess())
            {
                return;
            }

            try
            {
                ProcessAssetPostprocessEvent(
                    importedAssets,
                    deletedAssets,
                    movedAssets,
                    movedFromAssetPaths,
                    didDomainReload);
            }
            catch (Exception exception)
            {
                FailPhaseB($"Asset import event evaluation threw: {exception.Message}");
            }
        }

        internal static void OnAssetsAboutToSave(string[] paths)
        {
            if (AssetDatabase.IsAssetImportWorkerProcess())
            {
                return;
            }

            try
            {
                paths = paths ?? Array.Empty<string>();
                bool hasManagerEvent = paths.Any(
                    path => IsEditorPipelineManagerAsset(path) ||
                            IsFolderContainingEditorPipelineManager(path));
                bool hasProtectedPathEvent =
                    RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                        paths,
                        KnownSettingsPaths.Concat(
                            new[] { RecompileStatusCompatBootstrapPolicy.CanonicalSettingsPath }));

                if (RecompileStatusCompatBootstrapPolicy.ShouldRunPhaseB(
                        s_State,
                        didDomainReload: false,
                        hasManagerEvent,
                        hasProtectedPathEvent))
                {
                    RunPhaseB();
                }
            }
            catch (Exception exception)
            {
                FailPhaseB($"Asset save event evaluation threw: {exception.Message}");
            }
        }

        private static void OnObjectChangesPublished(ref ObjectChangeEventStream stream)
        {
            if (AssetDatabase.IsAssetImportWorkerProcess())
            {
                return;
            }

            try
            {
                for (int index = 0; index < stream.length; index++)
                {
                    ObjectChangeKind kind = stream.GetEventType(index);
                    if (kind != ObjectChangeKind.ChangeAssetObjectProperties)
                    {
                        continue;
                    }

                    stream.GetChangeAssetObjectPropertiesEvent(
                        index,
                        out ChangeAssetObjectPropertiesEventArgs change);
#if UNITY_6000_3_OR_NEWER
                    UnityEngine.Object changedObject = EditorUtility.EntityIdToObject(change.instanceId);
#else
                    UnityEngine.Object changedObject = EditorUtility.InstanceIDToObject(change.instanceId);
#endif
                    string guid = change.guid.ToString();
                    string guidPath = AssetDatabase.GUIDToAssetPath(change.guid);
                    bool guidResolvesToManager =
                        RecompileStatusCompatBootstrapPolicy.IsCanonicalSettingsPath(guidPath) ||
                        IsEditorPipelineManagerAsset(guidPath);

                    if (!RecompileStatusCompatBootstrapPolicy.IsRelevantObjectPropertyChange(
                            true,
                            changedObject is EditorPipelineManager,
                            KnownSettingsGuids.Contains(guid),
                            guidResolvesToManager))
                    {
                        continue;
                    }

                    RunPhaseB();
                    return;
                }
            }
            catch (Exception exception)
            {
                FailPhaseB($"Object property event evaluation threw: {exception.Message}");
            }
        }

        private static void ProcessAssetPostprocessEvent(
            string[] importedAssets,
            string[] deletedAssets,
            string[] movedAssets,
            string[] movedFromAssetPaths,
            bool didDomainReload)
        {
            importedAssets = importedAssets ?? Array.Empty<string>();
            deletedAssets = deletedAssets ?? Array.Empty<string>();
            movedAssets = movedAssets ?? Array.Empty<string>();
            movedFromAssetPaths = movedFromAssetPaths ?? Array.Empty<string>();

            string[] importedOrMoved = importedAssets.Concat(movedAssets).ToArray();
            string[] allChangedPaths = importedOrMoved
                .Concat(deletedAssets)
                .Concat(movedFromAssetPaths)
                .ToArray();

            bool hasManagerEvent = importedOrMoved.Any(
                path => IsEditorPipelineManagerAsset(path) ||
                        IsFolderContainingEditorPipelineManager(path));
            bool hasKnownSettingsPathEvent =
                RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                    allChangedPaths,
                    KnownSettingsPaths.Concat(
                        new[] { RecompileStatusCompatBootstrapPolicy.CanonicalSettingsPath }));

            if (!RecompileStatusCompatBootstrapPolicy.ShouldRunPhaseB(
                    s_State,
                    didDomainReload,
                    hasManagerEvent,
                    hasKnownSettingsPathEvent))
            {
                return;
            }

            RunPhaseB();
        }

        private static void CompletePhaseA()
        {
            // Pipeline 0.4 defaults to AutoStart=true while a cold import has not indexed the
            // settings asset. Force its initializer, stop immediately, then expose none of the
            // protected test/recompile commands until an import-complete event permits Phase B.
            string safetyError = StopServerAndInstallDisabledDiscovery(
                ensurePipelineInitialized: true);
            s_State = RecompileStatusCompatBootstrapState.DisabledAwaitingImport;

            if (!string.IsNullOrEmpty(safetyError))
            {
                Debug.LogError(
                    "[UnityPipelineCompat] Phase A could not prove the disabled bootstrap state: " +
                    safetyError);
            }
        }

        private static void RunPhaseB()
        {
            if (s_PhaseBInProgress)
            {
                return;
            }

            s_PhaseBInProgress = true;
            try
            {
                s_State = RecompileStatusCompatBootstrapState.DisabledAwaitingImport;
                string preparationError = StopServerAndInstallDisabledDiscovery(
                    ensurePipelineInitialized: false);
                if (!string.IsNullOrEmpty(preparationError))
                {
                    FailPhaseB(
                        "Unable to establish the disabled state before validation. " +
                        preparationError);
                    return;
                }

                if (!RecompileStatusCompatStartupGate.TryValidateSettingsAsset(
                        out string[] discoveredSettingsPaths,
                        out string startupGateError))
                {
                    ReplaceKnownSettingsPaths(discoveredSettingsPaths);
                    LogPhaseBFailure(startupGateError);
                    return;
                }

                ReplaceKnownSettingsPaths(discoveredSettingsPaths);

                var discovery = new RecompileStatusCompatDiscovery(new TypeCacheCommandDiscovery());
                CommandRegistry.SetDiscovery(discovery);

                CommandInfo[] commands = CommandRegistry.DiscoverCommands().ToArray();
                if (!RecompileStatusCompatStartupGate.TryValidateDiscoveryPostcondition(
                        discovery,
                        commands,
                        out string postconditionError))
                {
                    FailPhaseB(postconditionError);
                    return;
                }

                PipelineServerStartup.EnsureServerStarted();
                if (!IsPipelineServerRunning())
                {
                    FailPhaseB(
                        "The Pipeline server did not start after compatibility discovery was validated.");
                    return;
                }

                s_LastPhaseBFailure = null;
                s_State = RecompileStatusCompatBootstrapState.RunningCompat;
            }
            catch (Exception exception)
            {
                FailPhaseB($"Phase B threw while installing compatibility: {exception.Message}");
            }
            finally
            {
                s_PhaseBInProgress = false;
            }
        }

        private static bool IsPipelineServerRunning()
        {
            return PipelineServerStartup.Server != null && PipelineServerStartup.Server.IsRunning;
        }

        private static bool IsEditorPipelineManagerAsset(string path)
        {
            if (!RecompileStatusCompatBootstrapPolicy.IsAssetPath(path))
            {
                return false;
            }

            return AssetDatabase.LoadAssetAtPath<EditorPipelineManager>(path) != null;
        }

        private static bool IsFolderContainingEditorPipelineManager(string path)
        {
            bool isFolder = !string.IsNullOrEmpty(path) && AssetDatabase.IsValidFolder(path);
            int managerCount = isFolder
                ? AssetDatabase.FindAssets("t:EditorPipelineManager", new[] { path }).Length
                : 0;
            return RecompileStatusCompatBootstrapPolicy.IsImportedOrMovedManagerFolder(
                isFolder,
                managerCount);
        }

        private static void ReplaceKnownSettingsPaths(IEnumerable<string> paths)
        {
            KnownSettingsPaths.Clear();
            KnownSettingsGuids.Clear();
            if (paths == null)
            {
                return;
            }

            foreach (string path in paths.Where(path => !string.IsNullOrEmpty(path)))
            {
                KnownSettingsPaths.Add(path);
                string guid = AssetDatabase.AssetPathToGUID(path);
                if (!string.IsNullOrEmpty(guid))
                {
                    KnownSettingsGuids.Add(guid);
                }
            }
        }

        private static void FailPhaseB(string reason)
        {
            string safetyError = StopServerAndInstallDisabledDiscovery(
                ensurePipelineInitialized: false);
            s_State = RecompileStatusCompatBootstrapState.DisabledAwaitingImport;

            if (!string.IsNullOrEmpty(safetyError))
            {
                reason += $" Secondary failures: {safetyError}";
            }

            LogPhaseBFailure(reason);
        }

        private static void LogPhaseBFailure(string reason)
        {
            if (string.Equals(s_LastPhaseBFailure, reason, StringComparison.Ordinal))
            {
                return;
            }

            s_LastPhaseBFailure = reason;
            Debug.LogError(
                "[UnityPipelineCompat] Pipeline remains stopped and protected commands disabled: " +
                reason);
        }

        private static string StopServerAndInstallDisabledDiscovery(bool ensurePipelineInitialized)
        {
            var errors = new List<string>();

            if (ensurePipelineInitialized)
            {
                try
                {
                    RuntimeHelpers.RunClassConstructor(typeof(PipelineServerStartup).TypeHandle);
                }
                catch (Exception exception)
                {
                    errors.Add($"official startup initialization failed: {exception.Message}");
                }
            }

            try
            {
                PipelineServerStartup.StopServer();
            }
            catch (Exception exception)
            {
                errors.Add($"server stop failed: {exception.Message}");
            }

            try
            {
                // Keep every unrelated Pipeline command, but expose none of the protected test or
                // recompile commands when the exact replacement invariant cannot be proven.
                CommandRegistry.SetDiscovery(
                    new DisabledRecompileDiscovery(new TypeCacheCommandDiscovery()));

                int remainingProtectedCommands = CommandRegistry.DiscoverCommands()
                    .Count(command =>
                        command.Name == RecompileStatusCompatDiscovery.RecompileCommandName ||
                        command.Name == RecompileStatusCompatDiscovery.StatusCommandName ||
                        command.Name == RecompileStatusCompatDiscovery.RunTestsCommandName ||
                        command.Name == RecompileStatusCompatDiscovery.TestStatusCommandName);
                if (remainingProtectedCommands != 0)
                {
                    errors.Add(
                        $"disabled discovery still exposed {remainingProtectedCommands} protected commands");
                }
            }
            catch (Exception exception)
            {
                errors.Add($"disabled discovery installation failed: {exception.Message}");
            }

            return errors.Count == 0 ? null : string.Join("; ", errors);
        }

        private sealed class DisabledRecompileDiscovery : ICommandDiscovery
        {
            private readonly ICommandDiscovery _inner;

            internal DisabledRecompileDiscovery(ICommandDiscovery inner)
            {
                _inner = inner;
            }

            public IEnumerable<MethodInfo> GetMethodsWithAttribute<T>() where T : Attribute
            {
                IEnumerable<MethodInfo> methods = _inner.GetMethodsWithAttribute<T>();
                if (typeof(T) != typeof(CliCommandAttribute))
                {
                    return methods;
                }

                return methods.Where(method => !RecompileStatusCompatDiscovery.HasProtectedCommandName(method));
            }
        }
    }

    internal sealed class RecompileStatusCompatAssetPostprocessor : AssetPostprocessor
    {
        private static void OnPostprocessAllAssets(
            string[] importedAssets,
            string[] deletedAssets,
            string[] movedAssets,
            string[] movedFromAssetPaths,
            bool didDomainReload)
        {
            RecompileStatusCompatInstaller.OnAssetsPostprocessed(
                importedAssets,
                deletedAssets,
                movedAssets,
                movedFromAssetPaths,
                didDomainReload);
        }
    }

    internal sealed class RecompileStatusCompatAssetModificationProcessor : AssetModificationProcessor
    {
        private static string[] OnWillSaveAssets(string[] paths)
        {
            paths = paths ?? Array.Empty<string>();
            RecompileStatusCompatInstaller.OnAssetsAboutToSave(paths);
            return paths;
        }
    }
}
