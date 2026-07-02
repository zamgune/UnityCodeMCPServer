using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using UnityCodeMcpServer.Helpers;
using UnityCodeMcpServer.Interfaces;
using UnityCodeMcpServer.Protocol;
using UnityEditor;

namespace UnityCodeMcpServer.McpTools
{
    /// <summary>
    /// Tool that reads Unity Editor console logs via reflection.
    /// Provides recent log entries as text while guarding against reflection failures.
    /// </summary>
    public class ReadUnityConsoleLogsTool : ITool
    {
        private const int DefaultMaxEntries = 200;

        private readonly Func<int, Func<UnityConsoleLogEntry, bool>, UnityConsoleLogReadResult> _logReader;

        public ReadUnityConsoleLogsTool()
        {
            _logReader = UnityConsoleLogReader.ReadTail;
        }

        public ReadUnityConsoleLogsTool(Func<int, UnityConsoleLogReadResult> logReader)
        {
            if (logReader == null)
            {
                _logReader = UnityConsoleLogReader.ReadTail;
                return;
            }

            _logReader = (maxEntries, _) => logReader(maxEntries);
        }

        public ReadUnityConsoleLogsTool(Func<int, Func<UnityConsoleLogEntry, bool>, UnityConsoleLogReadResult> logReader)
        {
            if (logReader == null)
            {
                _logReader = UnityConsoleLogReader.ReadTail;
                return;
            }

            _logReader = logReader;
        }

        public string Name => "read_unity_console_logs";

        public string Description =>
            @"Retrieves recent log entries from the Unity Editor Console.

**WHEN TO USE:**
- To debug compilation errors, runtime exceptions, or Unity Editor issues.
- To investigate why a C# script execution failed or produced unexpected results.
- To verify the status of background tasks, asset imports, or editor actions that might generate silent warnings/errors.

**PARAMETERS & USAGE GUIDELINES:**
- `max_entries` (Optional): Limits the number of returned logs. You MUST use this to protect your context window from token bloat. Recommend setting this to 20-50 entries for standard debugging.
- `severities` (Optional): Filters logs by severity: error, warning, or info. Defaults to all.
- `message_contains` (Optional): Filters logs by a case-insensitive message substring.
- Output includes the log type (Message, Warning, Error, Exception), the log message, and stack traces for error entries only.";

        public JsonElement InputSchema => JsonHelper.ParseElement(@"
        {
            ""type"": ""object"",
            ""properties"": {
                ""max_entries"": {
                    ""type"": ""integer"",
                    ""minimum"": 1,
                    ""maximum"": 1000,
                    ""description"": ""Maximum number of log entries to return. Defaults to 200.""
                },
                ""severities"": {
                    ""type"": ""array"",
                    ""items"": {
                        ""type"": ""string"",
                        ""enum"": [""error"", ""warning"", ""info""]
                    },
                    ""description"": ""Severities to return. Defaults to all.""
                },
                ""message_contains"": {
                    ""type"": ""string"",
                    ""description"": ""Case-insensitive substring that log messages must contain.""
                }
            }
        }
        ");

        public ToolsCallResult Execute(JsonElement arguments)
        {
            int requested = arguments.GetIntOrDefault("max_entries", DefaultMaxEntries);
            int maxEntries = NormalizeMaxEntries(requested);

            if (!TryCreateLogFilter(arguments, out Func<UnityConsoleLogEntry, bool> predicate, out bool filtersActive, out string filterError))
            {
                return ToolsCallResult.ErrorResult(filterError);
            }

            UnityConsoleLogReadResult result = _logReader(maxEntries, predicate);
            string text;
            if (result.IsError && !string.IsNullOrWhiteSpace(result.ErrorText))
            {
                text = result.ErrorText;
            }
            else
            {
                text = FormatEntries(result.Entries, result.TotalCount, maxEntries, filtersActive);
            }

            string mode = EditorApplication.isPlaying ? "Play Mode" : "Edit Mode";
            text = $"**Unity Editor is in {mode}**\n\n{text}";

            return ToolsCallResult.TextResult(text, result.IsError);
        }

        private static int NormalizeMaxEntries(int requested)
        {
            if (requested < 1)
            {
                return DefaultMaxEntries;
            }

            return Math.Min(requested, UnityConsoleLogReader.MaxEntriesLimit);
        }

        public static string FormatEntries(IReadOnlyList<UnityConsoleLogEntry> entries, int totalCount, int maxEntries, bool filtersActive = false)
        {
            if (entries == null || entries.Count == 0)
            {
                return filtersActive ? "(No matching console logs available)" : "(No console logs available)";
            }

            int effectiveLimit = NormalizeMaxEntries(maxEntries);
            StringBuilder sb = new();

            if (filtersActive)
            {
                AppendLine(sb, $"--- Showing last {entries.Count} matching logs (Total scanned: {totalCount}) ---");
            }
            else if (totalCount > effectiveLimit)
            {
                AppendLine(sb, $"--- Showing last {entries.Count} logs (Total: {totalCount}) ---");
            }

            for (int i = 0; i < entries.Count; i++)
            {
                UnityConsoleLogEntry entry = entries[i];
                AppendLine(sb, GetDisplayMessage(entry));

                if (ShouldIncludeStackTrace(entry.Severity) && !string.IsNullOrWhiteSpace(entry.StackTrace))
                {
                    AppendLine(sb, entry.StackTrace);
                }
            }

            return sb.ToString().TrimEnd();
        }

        private static bool TryCreateLogFilter(JsonElement arguments, out Func<UnityConsoleLogEntry, bool> predicate, out bool filtersActive, out string errorText)
        {
            predicate = null;
            filtersActive = false;
            errorText = null;

            HashSet<UnityConsoleLogSeverity> severities = null;
            if (arguments.TryGetProperty("severities", out JsonElement severitiesElement))
            {
                filtersActive = true;
                if (severitiesElement.ValueKind != JsonValueKind.Array)
                {
                    errorText = "Invalid severities: expected an array of strings.";
                    return false;
                }

                severities = new HashSet<UnityConsoleLogSeverity>();
                foreach (JsonElement severityElement in severitiesElement.EnumerateArray())
                {
                    if (severityElement.ValueKind != JsonValueKind.String)
                    {
                        errorText = "Invalid severities: expected an array of strings.";
                        return false;
                    }

                    string severityText = severityElement.GetString();
                    if (!TryParseSeverity(severityText, out UnityConsoleLogSeverity severity))
                    {
                        errorText = $"Invalid severity '{severityText}'. Expected one of: error, warning, info.";
                        return false;
                    }

                    severities.Add(severity);
                }
            }

            string messageContains = null;
            if (arguments.TryGetProperty("message_contains", out JsonElement messageContainsElement))
            {
                if (messageContainsElement.ValueKind != JsonValueKind.String)
                {
                    errorText = "Invalid message_contains: expected a string.";
                    return false;
                }

                messageContains = messageContainsElement.GetString();
                if (!string.IsNullOrEmpty(messageContains))
                {
                    filtersActive = true;
                }
            }

            if (!filtersActive)
            {
                return true;
            }

            predicate = entry =>
            {
                if (severities != null && !severities.Contains(entry.Severity))
                {
                    return false;
                }

                if (!string.IsNullOrEmpty(messageContains)
                    && (entry.Message == null || entry.Message.IndexOf(messageContains, StringComparison.OrdinalIgnoreCase) < 0))
                {
                    return false;
                }

                return true;
            };
            return true;
        }

        private static bool TryParseSeverity(string value, out UnityConsoleLogSeverity severity)
        {
            if (string.Equals(value, "error", StringComparison.OrdinalIgnoreCase))
            {
                severity = UnityConsoleLogSeverity.Error;
                return true;
            }

            if (string.Equals(value, "warning", StringComparison.OrdinalIgnoreCase))
            {
                severity = UnityConsoleLogSeverity.Warning;
                return true;
            }

            if (string.Equals(value, "info", StringComparison.OrdinalIgnoreCase))
            {
                severity = UnityConsoleLogSeverity.Info;
                return true;
            }

            severity = UnityConsoleLogSeverity.Unknown;
            return false;
        }

        private static bool ShouldIncludeStackTrace(UnityConsoleLogSeverity severity)
        {
            return severity == UnityConsoleLogSeverity.Error;
        }

        private static void AppendLine(StringBuilder sb, string text)
        {
            sb.Append(text);
            sb.Append('\n');
        }

        private static string GetDisplayMessage(UnityConsoleLogEntry entry)
        {
            if (entry.Severity != UnityConsoleLogSeverity.Info)
            {
                return entry.Message;
            }

            string normalizedText = entry.Message?.Replace("\r\n", "\n").Replace('\r', '\n');
            if (string.IsNullOrWhiteSpace(normalizedText))
            {
                return string.Empty;
            }

            int firstNewline = normalizedText.IndexOf('\n');
            return firstNewline >= 0 ? normalizedText[..firstNewline].TrimEnd() : normalizedText;
        }
    }
}
