using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using Unity.Pipeline.Commands;

namespace Zamgune.UnityPipelineCompat
{
    /// <summary>
    /// Converts Pipeline 0.4's JSON-string test status into the object contract expected by
    /// Unity CLI 1.0.0-beta.3. The CLI's hidden post-run_tests poll waits for an object whose
    /// isRunning member is false; the authoritative test lifecycle remains the status member.
    /// </summary>
    internal static class TestStatusCompatCommand
    {
        private static readonly HashSet<string> AllowedStatuses =
            new HashSet<string>(StringComparer.Ordinal)
            {
                "running",
                "in_progress",
                "completed",
                "cancelled",
                "error",
                "no_tests"
            };

        internal static Func<string> ReadOfficialStatus = PipelineApiBridge.TestStatus;
        internal static Func<bool> HasPendingRequest =
            () => File.Exists("Temp/pipeline_test_request.json");

        [CliCommand(
            "test_status",
            "Get status of running async test execution",
            MainThreadRequired = false)]
        public static JObject GetTestStatus()
        {
            try
            {
                // Pipeline writes the request before deleting the previous status. Prefer the
                // request marker so a stale completed payload cannot turn a new run into a false
                // terminal result during that bounded start window.
                if (HasPendingRequest())
                {
                    return RunningResult();
                }

                string payload = ReadOfficialStatus();
                // test_status is background-safe while run_tests creates the marker on Unity's
                // main thread. Recheck after reading so a request that starts during the status
                // read cannot publish the previous run's completed payload as the new result.
                if (HasPendingRequest())
                {
                    return RunningResult();
                }

                return ParseOfficialStatus(payload);
            }
            catch (Exception exception)
            {
                // The official reader checks existence before reading. A new run can create its
                // request marker and delete the old status between those two file operations,
                // making the read throw. Prefer the new request over that stale-read failure.
                try
                {
                    if (HasPendingRequest())
                    {
                        return RunningResult();
                    }
                }
                catch (Exception markerException)
                {
                    return ErrorResult(
                        $"Official test_status threw: {exception.Message}; " +
                        $"pending-request recheck threw: {markerException.Message}");
                }

                return ErrorResult($"Official test_status threw: {exception.Message}");
            }
        }

        internal static JObject ParseOfficialStatus(string payload)
        {
            if (string.IsNullOrWhiteSpace(payload))
            {
                return ErrorResult("Official test_status returned an empty payload.");
            }

            try
            {
                JToken parsed = JToken.Parse(payload);
                if (parsed.Type != JTokenType.Object)
                {
                    return ErrorResult("Official test_status did not return a JSON object.");
                }

                var result = (JObject)parsed;
                JToken statusToken = result.GetValue("status", StringComparison.Ordinal);
                if (statusToken?.Type != JTokenType.String)
                {
                    return ErrorResult("Official test_status omitted its string status field.");
                }

                string status = statusToken.Value<string>();
                if (!AllowedStatuses.Contains(status))
                {
                    return ErrorResult($"Official test_status returned unsupported status '{status}'.");
                }

                // beta.3 otherwise polls inside the MCP tool call for up to ten minutes. False here
                // means the CLI transport may return this snapshot; status remains authoritative,
                // so the router continues polling while status is running or in_progress.
                result["isRunning"] = false;
                return result;
            }
            catch (Exception exception)
            {
                return ErrorResult($"Official test_status returned malformed JSON: {exception.Message}");
            }
        }

        internal static void ResetTestHooks()
        {
            ReadOfficialStatus = PipelineApiBridge.TestStatus;
            HasPendingRequest = () => File.Exists("Temp/pipeline_test_request.json");
        }

        private static JObject ErrorResult(string message)
        {
            return new JObject
            {
                ["status"] = "error",
                ["isRunning"] = false,
                ["message"] = message
            };
        }

        private static JObject RunningResult()
        {
            return new JObject
            {
                ["status"] = "running",
                ["isRunning"] = false
            };
        }
    }
}
