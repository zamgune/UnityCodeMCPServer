using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Unity.Pipeline.Commands;
using Unity.Pipeline.Editor.Commands;
using UnityEditor;
using UnityEditor.Compilation;

namespace Zamgune.UnityPipelineCompat
{
    /// <summary>
    /// Preserves Pipeline 0.4's normal recompile behavior and adds an explicit, source-neutral
    /// force path for lifecycle canaries. The default remains a direct delegation to the official
    /// command. Force mode is opt-in and requests a clean script compilation only when the official
    /// refresh did not already start one.
    /// </summary>
    public static class RecompileCompatCommand
    {
        internal static Func<bool, object> OfficialRecompile =
            focus => RecompileCommand.Recompile(focus);
        internal static Func<bool> IsCompiling = () => EditorApplication.isCompiling;
        internal static Action RequestCleanCompilation = () =>
            CompilationPipeline.RequestScriptCompilation(
                RequestScriptCompilationOptions.CleanBuildCache);
        internal static Action<string, bool, string[]> PersistStatus =
            RecompileStatusCompatCommand.WriteStatus;

        [CliCommand(
            "recompile",
            "Refresh scripts using official Pipeline behavior. Set force=true to request a source-neutral clean script compilation for an explicit reload canary.",
            MainThreadRequired = true)]
        public static object Recompile(
            [CliArg(
                "focus",
                "If true, bring the Editor to the foreground before compiling. Off by default.")]
            bool focus = false,
            [CliArg(
                "force",
                "If true and the official refresh is up to date, request a clean script compilation without changing source bytes. Off by default.")]
            bool force = false)
        {
            object officialResult = OfficialRecompile(focus);
            if (!force || IsCompiling())
            {
                return officialResult;
            }

            try
            {
                PersistStatus("triggered", false, Array.Empty<string>());
                RequestCleanCompilation();
                bool isCompiling = IsCompiling();
                return new JObject
                {
                    ["status"] = isCompiling ? "compiling" : "triggered",
                    ["failed"] = false,
                    ["errors"] = new JArray(),
                    ["isCompiling"] = isCompiling,
                    ["forced"] = true,
                    ["message"] =
                        "Clean script compilation requested. Poll recompile_status until completed."
                };
            }
            catch (Exception exception)
            {
                string error = $"Unable to request a clean script compilation: {exception.Message}";
                try
                {
                    PersistStatus("completed", true, new[] { error });
                }
                catch
                {
                    // The structured command response still fails closed when persistence itself is
                    // unavailable. Never request or retry compilation after a status-write failure.
                }

                return Failure(error);
            }
        }

        internal static JObject Failure(string error)
        {
            return new JObject
            {
                ["status"] = "error",
                ["failed"] = true,
                ["errors"] = new JArray(error),
                ["isCompiling"] = false,
                ["forced"] = true
            };
        }

        internal static void ResetTestHooks()
        {
            OfficialRecompile = focus => RecompileCommand.Recompile(focus);
            IsCompiling = () => EditorApplication.isCompiling;
            RequestCleanCompilation = () =>
                CompilationPipeline.RequestScriptCompilation(
                    RequestScriptCompilationOptions.CleanBuildCache);
            PersistStatus = RecompileStatusCompatCommand.WriteStatus;
        }
    }

    /// <summary>
    /// Normalizes Pipeline's persisted JSON-string recompile status into a structured object.
    /// The command is explicitly background-safe: it reads only the persisted status file and
    /// never queries EditorApplication or other main-thread-only Editor state.
    /// </summary>
    public static class RecompileStatusCompatCommand
    {
        internal const string StatusFile = "Temp/pipeline_recompile_status.json";

        [CliCommand(
            "recompile_status",
            "Get structured status for the last official Pipeline recompile.",
            MainThreadRequired = false)]
        public static JObject RecompileStatus()
        {
            try
            {
                if (!File.Exists(StatusFile))
                {
                    return NoFileIdleResult();
                }

                return ParseOfficialStatus(File.ReadAllText(StatusFile));
            }
            catch (Exception exception)
            {
                return Failure($"Unable to read the persisted Pipeline recompile status: {exception.Message}");
            }
        }

        internal static JObject ParseOfficialStatus(string officialJson)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(officialJson))
                {
                    return Failure("The persisted Pipeline recompile status was empty.");
                }

                JObject source = JObject.Parse(officialJson);
                JToken statusToken = source["status"];
                if (statusToken == null || statusToken.Type != JTokenType.String)
                {
                    return Failure("The persisted Pipeline recompile status did not contain a string status field.");
                }

                string status = statusToken.Value<string>();
                if (!IsSupportedPersistedStatus(status))
                {
                    return Failure($"The persisted Pipeline recompile status was unsupported: {status ?? "<null>"}.");
                }

                JToken failedToken = source["failed"];
                if (failedToken == null || failedToken.Type != JTokenType.Boolean)
                {
                    return Failure(
                        "The persisted Pipeline recompile status did not contain a boolean failed field.");
                }

                JToken errorsToken = source["errors"];
                if (errorsToken == null || errorsToken.Type != JTokenType.Array)
                {
                    return Failure(
                        "The persisted Pipeline recompile status did not contain an array errors field.");
                }

                var errors = (JArray)errorsToken.DeepClone();
                if (errors.Any(error => error.Type != JTokenType.String))
                {
                    return Failure(
                        "The persisted Pipeline recompile status contained a non-string errors entry.");
                }

                return new JObject
                {
                    ["status"] = status,
                    ["failed"] = failedToken.Value<bool>(),
                    ["errors"] = errors,
                    ["isCompiling"] = status == "compiling"
                };
            }
            catch (Exception exception)
            {
                return Failure($"Unable to parse the persisted Pipeline recompile status: {exception.Message}");
            }
        }

        internal static JObject NoFileIdleResult()
        {
            return new JObject
            {
                ["status"] = "idle",
                ["failed"] = false,
                ["errors"] = new JArray(),
                ["isCompiling"] = false
            };
        }

        private static bool IsSupportedPersistedStatus(string status)
        {
            return status == "triggered" ||
                   status == "compiling" ||
                   status == "completed" ||
                   status == "up_to_date";
        }

        private static JObject Failure(string error)
        {
            return new JObject
            {
                ["status"] = "error",
                ["failed"] = true,
                ["errors"] = new JArray(error),
                ["isCompiling"] = false
            };
        }

        internal static void WriteStatus(string status, bool failed, string[] errors)
        {
            var payload = new JObject
            {
                ["status"] = status,
                ["failed"] = failed,
                ["errors"] = new JArray(errors ?? Array.Empty<string>())
            };
            File.WriteAllText(StatusFile, payload.ToString(Newtonsoft.Json.Formatting.None));
        }
    }
}
