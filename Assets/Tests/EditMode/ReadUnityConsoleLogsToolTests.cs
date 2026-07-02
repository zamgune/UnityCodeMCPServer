using System;
using System.Collections.Generic;
using System.Text.Json;
using NUnit.Framework;
using UnityCodeMcpServer.Helpers;
using UnityCodeMcpServer.McpTools;
using UnityCodeMcpServer.Protocol;
using UnityEngine;

namespace UnityCodeMcpServer.Tests.EditMode
{
    public class ReadUnityConsoleLogsToolTests
    {
        [Test]
        public void Tool_Metadata_IsPresent()
        {
            ReadUnityConsoleLogsTool tool = new();

            Assert.AreEqual("read_unity_console_logs", tool.Name);
            Assert.IsNotEmpty(tool.Description);
        }

        [Test]
        public void InputSchema_DefinesMaxEntries()
        {
            JsonElement schema = new ReadUnityConsoleLogsTool().InputSchema;

            Assert.AreEqual(JsonValueKind.Object, schema.ValueKind);
            Assert.IsTrue(schema.TryGetProperty("properties", out JsonElement properties));
            Assert.IsTrue(properties.TryGetProperty("max_entries", out JsonElement maxEntries));
            Assert.AreEqual(JsonValueKind.Object, maxEntries.ValueKind);
            Assert.IsTrue(properties.TryGetProperty("severities", out JsonElement severities));
            Assert.AreEqual(JsonValueKind.Object, severities.ValueKind);
            Assert.IsTrue(properties.TryGetProperty("message_contains", out JsonElement messageContains));
            Assert.AreEqual(JsonValueKind.Object, messageContains.ValueKind);
        }

        [Test]
        public void Execute_UsesDefaultLimit_WhenNotProvided()
        {
            int capturedLimit = -1;
            ReadUnityConsoleLogsTool tool = new(limit =>
            {
                capturedLimit = limit;
                return CreateReaderResult(new UnityConsoleLogEntry("stub log", null, UnityConsoleLogSeverity.Info));
            });

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement("{}"));

            Assert.AreEqual(200, capturedLimit);
            Assert.IsFalse(result.IsError);
            StringAssert.Contains("stub log", result.Content[0].Text);
        }

        [Test]
        public void Execute_ClampsLimit_ToUpperBound()
        {
            int capturedLimit = -1;
            ReadUnityConsoleLogsTool tool = new(limit =>
            {
                capturedLimit = limit;
                return CreateReaderResult(new UnityConsoleLogEntry("ok", null, UnityConsoleLogSeverity.Info));
            });

            JsonElement args = JsonHelper.ParseElement("{\"max_entries\": 5000}");
            tool.Execute(args);

            Assert.AreEqual(1000, capturedLimit);
        }

        [Test]
        public void Execute_DefaultsLimit_WhenNegativeProvided()
        {
            int capturedLimit = -1;
            ReadUnityConsoleLogsTool tool = new(limit =>
            {
                capturedLimit = limit;
                return CreateReaderResult(new UnityConsoleLogEntry("ok", null, UnityConsoleLogSeverity.Info));
            });

            JsonElement args = JsonHelper.ParseElement("{\"max_entries\": -5}");
            tool.Execute(args);

            Assert.AreEqual(200, capturedLimit);
        }

        [Test]
        public void Execute_FiltersBySeverity()
        {
            ReadUnityConsoleLogsTool tool = CreateToolWithEntries(
                new UnityConsoleLogEntry("plain alpha", null, UnityConsoleLogSeverity.Info),
                new UnityConsoleLogEntry("warning bravo", null, UnityConsoleLogSeverity.Warning),
                new UnityConsoleLogEntry("error charlie", null, UnityConsoleLogSeverity.Error));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement(@"{""severities"": [""warning""]}"));
            string text = result.Content[0].Text;

            Assert.IsFalse(result.IsError);
            StringAssert.Contains("warning bravo", text);
            StringAssert.DoesNotContain("plain alpha", text);
            StringAssert.DoesNotContain("error charlie", text);
        }

        [Test]
        public void Execute_FiltersByMessageContains_CaseInsensitive()
        {
            ReadUnityConsoleLogsTool tool = CreateToolWithEntries(
                new UnityConsoleLogEntry("alpha needle", null, UnityConsoleLogSeverity.Info),
                new UnityConsoleLogEntry("bravo outside", null, UnityConsoleLogSeverity.Info),
                new UnityConsoleLogEntry("charlie NEEDLE", null, UnityConsoleLogSeverity.Warning));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement(@"{""message_contains"": ""NeEdLe""}"));
            string text = result.Content[0].Text;

            Assert.IsFalse(result.IsError);
            StringAssert.Contains("alpha needle", text);
            StringAssert.Contains("charlie NEEDLE", text);
            StringAssert.DoesNotContain("bravo outside", text);
        }

        [Test]
        public void Execute_CombinesSeverityAndMessageContainsFilters()
        {
            ReadUnityConsoleLogsTool tool = CreateToolWithEntries(
                new UnityConsoleLogEntry("network alpha", null, UnityConsoleLogSeverity.Error),
                new UnityConsoleLogEntry("network bravo", null, UnityConsoleLogSeverity.Warning),
                new UnityConsoleLogEntry("graphics alpha", null, UnityConsoleLogSeverity.Error));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement(@"{""severities"": [""error""], ""message_contains"": ""network""}"));
            string text = result.Content[0].Text;

            Assert.IsFalse(result.IsError);
            StringAssert.Contains("network alpha", text);
            StringAssert.DoesNotContain("network bravo", text);
            StringAssert.DoesNotContain("graphics alpha", text);
        }

        [Test]
        public void Execute_AppliesFiltersBeforeTailCut()
        {
            ReadUnityConsoleLogsTool tool = CreateToolWithEntries(
                new UnityConsoleLogEntry("old error one", null, UnityConsoleLogSeverity.Error),
                new UnityConsoleLogEntry("old error two", null, UnityConsoleLogSeverity.Error),
                new UnityConsoleLogEntry("old error three", null, UnityConsoleLogSeverity.Error),
                new UnityConsoleLogEntry("new info one", null, UnityConsoleLogSeverity.Info),
                new UnityConsoleLogEntry("new info two", null, UnityConsoleLogSeverity.Info),
                new UnityConsoleLogEntry("new info three", null, UnityConsoleLogSeverity.Info));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement(@"{""severities"": [""error""], ""max_entries"": 2}"));
            string text = result.Content[0].Text;

            Assert.IsFalse(result.IsError);
            StringAssert.Contains("old error two", text);
            StringAssert.Contains("old error three", text);
            StringAssert.DoesNotContain("old error one", text);
            StringAssert.DoesNotContain("new info three", text);
        }

        [Test]
        public void Execute_ReturnsError_ForInvalidSeverity()
        {
            ReadUnityConsoleLogsTool tool = CreateToolWithEntries(
                new UnityConsoleLogEntry("plain alpha", null, UnityConsoleLogSeverity.Info));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement(@"{""severities"": [""fatal""]}"));

            Assert.IsTrue(result.IsError);
            StringAssert.Contains("Invalid severity 'fatal'. Expected one of: error, warning, info.", result.Content[0].Text);
        }

        [Test]
        public void Execute_PropagatesReaderError()
        {
            ReadUnityConsoleLogsTool tool = new(_ => new UnityConsoleLogReadResult(Array.Empty<UnityConsoleLogEntry>(), 0, "reader failure", true));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement("{}"));

            Assert.IsTrue(result.IsError);
            StringAssert.Contains("reader failure", result.Content[0].Text);
        }

        [Test]
        public void Execute_ReadsUnityLogs_AndReturnsContent()
        {
            ReadUnityConsoleLogsTool tool = new();
            string uniqueMessage = "ConsoleLog_" + Guid.NewGuid();
            Debug.Log(uniqueMessage);

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement("{}"));

            Assert.IsFalse(result.IsError);
            Assert.IsNotEmpty(result.Content);
            StringAssert.Contains(uniqueMessage, result.Content[0].Text);
        }

        [Test]
        public void Execute_EmitsTruncationHeader_WhenReaderIndicatesTruncation()
        {
            int capturedLimit = -1;
            ReadUnityConsoleLogsTool tool = new(limit =>
            {
                capturedLimit = limit;
                return new UnityConsoleLogReadResult(
                    new[]
                    {
                        new UnityConsoleLogEntry("new", null, UnityConsoleLogSeverity.Info)
                    },
                    limit + 1,
                    null,
                    false);
            });

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement("{\"max_entries\": 1}"));

            Assert.AreEqual(1, capturedLimit);
            Assert.IsFalse(result.IsError);
            StringAssert.Contains("Showing last 1 logs", result.Content[0].Text);
        }

        [Test]
        public void Execute_Replaces_EmptyReaderText_WithPlaceholder()
        {
            ReadUnityConsoleLogsTool tool = new(_ => new UnityConsoleLogReadResult(Array.Empty<UnityConsoleLogEntry>(), 0, null, false));

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement("{}"));

            Assert.IsFalse(result.IsError);
            StringAssert.Contains("(No console logs available)", result.Content[0].Text);
        }

        [Test]
        public void SelectTail_ReturnsNewestLogs_LikeTail()
        {
            IReadOnlyList<UnityConsoleLogEntry> tail = UnityConsoleLogReader.SelectTail(
                new[]
                {
                    new UnityConsoleLogEntry("oldest"),
                    new UnityConsoleLogEntry("middle"),
                    new UnityConsoleLogEntry("newest")
                },
                2);

            Assert.AreEqual(2, tail.Count);
            Assert.AreEqual("middle", tail[0].Message);
            Assert.AreEqual("newest", tail[1].Message);
        }

        [Test]
        public void FormatEntries_RendersMessageWithoutTimestampPrefix()
        {
            string text = ReadUnityConsoleLogsTool.FormatEntries(
                new[]
                {
                    new UnityConsoleLogEntry("message")
                },
                1,
                1);

            Assert.AreEqual("message", text);
        }

        [Test]
        public void FormatEntries_StripsUnknownSeverityStackTrace()
        {
            string text = ReadUnityConsoleLogsTool.FormatEntries(
                new[]
                {
                    new UnityConsoleLogEntry("message\nsecond-line", "unknown-stack", UnityConsoleLogSeverity.Unknown)
                },
                1,
                1);

            StringAssert.Contains("message\nsecond-line", text);
            StringAssert.DoesNotContain("unknown-stack", text);
        }

        [Test]
        public void Execute_StripsStackTrace_ForPlainLogs_AndWarnings()
        {
            ReadUnityConsoleLogsTool tool = new();
            string probeId = Guid.NewGuid().ToString("N");
            string plainLog = "plain-log-" + probeId;
            string warningLog = "warning-log-" + probeId;

            Debug.Log(plainLog);
            Debug.LogWarning(warningLog);

            ToolsCallResult result = tool.Execute(JsonHelper.ParseElement("{\"max_entries\": 5}"));
            string text = result.Content[0].Text;

            StringAssert.DoesNotContain($"{plainLog}\nUnityEngine.Debug:Log (object)", text);
            StringAssert.Contains(warningLog, text);
            StringAssert.DoesNotContain($"{warningLog}\nUnityEngine.Debug:LogWarning (object)", text);
        }

        [Test]
        public void FormatEntries_KeepsStackTrace_ForErrors()
        {
            string text = ReadUnityConsoleLogsTool.FormatEntries(
                new[]
                {
                    new UnityConsoleLogEntry("error-message", "error-stack", UnityConsoleLogSeverity.Error)
                },
                1,
                1);

            StringAssert.Contains("error-message", text);
            StringAssert.Contains("error-stack", text);
        }

        private static UnityConsoleLogReadResult CreateReaderResult(params UnityConsoleLogEntry[] entries)
        {
            return new UnityConsoleLogReadResult(entries, entries.Length, null, false);
        }

        private static ReadUnityConsoleLogsTool CreateToolWithEntries(params UnityConsoleLogEntry[] entries)
        {
            return new ReadUnityConsoleLogsTool((maxEntries, predicate) =>
            {
                IReadOnlyList<UnityConsoleLogEntry> selectedEntries = predicate == null
                    ? UnityConsoleLogReader.SelectTail(entries, maxEntries)
                    : UnityConsoleLogReader.SelectTail(entries, maxEntries, predicate);
                return new UnityConsoleLogReadResult(selectedEntries, entries.Length, null, false);
            });
        }
    }
}
