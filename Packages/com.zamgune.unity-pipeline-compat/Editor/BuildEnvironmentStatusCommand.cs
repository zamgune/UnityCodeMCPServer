using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEngine;
#if UNITY_6000_5_OR_NEWER
using UnityEditor.Build.Profile;
#endif

namespace Zamgune.UnityPipelineCompat
{
    /// <summary>
    /// Reports the Editor build environment without changing the active profile, target, or project.
    /// Unity 6000.5 added the typed BuildProfile inventory APIs used by the extended response.
    /// </summary>
    public static class BuildEnvironmentStatusCommand
    {
        internal const string CommandName = "zamgune_build_environment_status";
        internal const int SchemaVersion = 1;

        [CliCommand(
            CommandName,
            "Read Unity version, Editor/build readiness, Unity 6.5 Build Profiles, installed platform modules, and mobile target support without mutating the project.",
            MainThreadRequired = true)]
        public static JObject GetStatus()
        {
            var result = new JObject
            {
                ["schemaVersion"] = SchemaVersion,
                ["unityVersion"] = Application.unityVersion,
                ["projectPath"] = CanonicalProjectPath(),
                ["editorPid"] = Process.GetCurrentProcess().Id,
                ["batchMode"] = Application.isBatchMode,
                ["isCompiling"] = EditorApplication.isCompiling,
                ["isUpdating"] = EditorApplication.isUpdating,
                ["isPlayingOrWillChangePlaymode"] = EditorApplication.isPlayingOrWillChangePlaymode,
                ["activeBuildTarget"] = EditorUserBuildSettings.activeBuildTarget.ToString(),
                ["entityIdEncoding"] = "uint64-decimal-string",
                ["targetSupport"] = BuildTargetSupport(),
                ["buildProfileApisAvailable"] = false,
                ["activeBuildProfile"] = JValue.CreateNull(),
                ["buildProfiles"] = new JArray(),
                ["installedPlatformModules"] = new JArray()
            };

#if UNITY_6000_5_OR_NEWER
            BuildProfile activeProfile = BuildProfile.GetActiveBuildProfile();
            BuildProfile[] profiles = (BuildProfile.GetAllBuildProfiles() ?? Array.Empty<BuildProfile>())
                .Where(profile => profile != null)
                .OrderBy(ProfilePath, StringComparer.Ordinal)
                .ThenBy(profile => profile.name, StringComparer.Ordinal)
                .ToArray();
            InstalledPlatformInfo[] installedPlatforms =
                (BuildProfile.GetInstalledPlatformModules() ?? Array.Empty<InstalledPlatformInfo>())
                .OrderBy(platform => platform.displayName, StringComparer.Ordinal)
                .ThenBy(platform => platform.platformGuid.ToString(), StringComparer.Ordinal)
                .ToArray();

            result["buildProfileApisAvailable"] = true;
            result["activeBuildProfile"] = activeProfile == null
                ? JValue.CreateNull()
                : ProfileJson(activeProfile, activeProfile);
            result["buildProfiles"] = new JArray(profiles.Select(profile => ProfileJson(profile, activeProfile)));
            result["installedPlatformModules"] = new JArray(installedPlatforms.Select(platform =>
                new JObject
                {
                    ["displayName"] = platform.displayName ?? string.Empty,
                    ["platformGuid"] = platform.platformGuid.ToString()
                }));
#else
            result["buildProfileApisUnavailableReason"] =
                "BuildProfile inventory APIs require Unity 6000.5 or newer.";
#endif

            return result;
        }

        private static string CanonicalProjectPath()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        private static JArray BuildTargetSupport()
        {
            return new JArray(
                TargetSupport("Android", BuildTargetGroup.Android, BuildTarget.Android),
                TargetSupport("iOS", BuildTargetGroup.iOS, BuildTarget.iOS),
                TargetSupport("macOS", BuildTargetGroup.Standalone, BuildTarget.StandaloneOSX));
        }

        private static JObject TargetSupport(
            string displayName,
            BuildTargetGroup group,
            BuildTarget target)
        {
            return new JObject
            {
                ["displayName"] = displayName,
                ["buildTargetGroup"] = group.ToString(),
                ["buildTarget"] = target.ToString(),
                ["supported"] = BuildPipeline.IsBuildTargetSupported(group, target)
            };
        }

#if UNITY_6000_5_OR_NEWER
        private static JObject ProfileJson(BuildProfile profile, BuildProfile activeProfile)
        {
            return new JObject
            {
                ["name"] = profile.name ?? string.Empty,
                ["assetPath"] = ProfilePath(profile),
                // Unity 6000.5 exposes this as a static conversion, not an instance method.
                ["entityId"] = EntityId.ToULong(profile.GetEntityId()).ToString(CultureInfo.InvariantCulture),
                ["isActive"] = profile == activeProfile,
                ["overrideGlobalScenes"] = profile.overrideGlobalScenes,
                ["scriptingDefines"] = new JArray(profile.scriptingDefines ?? Array.Empty<string>()),
                ["scenes"] = new JArray((profile.GetScenesForBuild() ?? Array.Empty<EditorBuildSettingsScene>())
                    .Select(scene => new JObject
                    {
                        ["path"] = scene.path ?? string.Empty,
                        ["enabled"] = scene.enabled
                    }))
            };
        }

        private static string ProfilePath(BuildProfile profile)
        {
            return AssetDatabase.GetAssetPath(profile) ?? string.Empty;
        }
#endif
    }
}
