using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using Unity.Pipeline.Commands;
using Unity.Pipeline.Editor.Commands;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public class TestStatusCompatTests
    {
        [TearDown]
        public void TearDown()
        {
            TestStatusCompatCommand.ResetTestHooks();
        }

        [Test]
        public void Command_ExposesZeroArgumentBackgroundSafeObjectContract()
        {
            MethodInfo method = typeof(TestStatusCompatCommand)
                .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus));
            CliCommandAttribute attribute = method?.GetCustomAttribute<CliCommandAttribute>();

            Assert.That(method, Is.Not.Null);
            Assert.That(method.ReturnType, Is.EqualTo(typeof(JObject)));
            Assert.That(method.GetParameters(), Is.Empty);
            Assert.That(attribute, Is.Not.Null);
            Assert.That(attribute.Name, Is.EqualTo("test_status"));
            Assert.That(attribute.Description,
                Is.EqualTo("Get status of running async test execution"));
            Assert.That(attribute.MainThreadRequired, Is.False);
        }

        [Test]
        public void DiscoveryTarget_PreservesOfficialRunTestsInputSchemaExactly()
        {
            MethodInfo method = typeof(TestCommands).GetMethod(nameof(TestCommands.RunTests));
            CliCommandAttribute command = method?.GetCustomAttribute<CliCommandAttribute>();
            ParameterInfo[] parameters = method?.GetParameters();

            Assert.That(method, Is.Not.Null);
            Assert.That(command, Is.Not.Null);
            Assert.That(command.Name, Is.EqualTo("run_tests"));
            Assert.That(command.Description, Is.EqualTo("Execute Unity tests with filtering options"));
            Assert.That(command.MainThreadRequired, Is.True);
            Assert.That(parameters, Has.Length.EqualTo(6));

            CollectionAssert.AreEqual(
                new[] { "mode", "filter", "filterType", "includeExplicit", "asyncTests", "timeout" },
                parameters.Select(parameter => parameter.Name));
            CollectionAssert.AreEqual(
                new[] { "mode", "filter", "filter_type", "include_explicit", "async_tests", "timeout" },
                parameters.Select(parameter =>
                    parameter.GetCustomAttribute<CliArgAttribute>()?.Name));
            CollectionAssert.AreEqual(
                new object[] { "all", "", "testName", false, false, 300 },
                parameters.Select(parameter => parameter.DefaultValue));
            CollectionAssert.AreEqual(
                new[]
                {
                    "Test mode: all, editor, playmode (default: all)",
                    "Test name filter pattern (case-insensitive partial match)",
                    "Filter type: testName, assembly, category (default: testName)",
                    "Include tests marked with [Explicit] attribute",
                    "Run asynchronously - return immediately, poll /test-status for results",
                    "Test execution timeout in seconds (default: 300)"
                },
                parameters.Select(parameter =>
                    parameter.GetCustomAttribute<CliArgAttribute>()?.Description));
        }

        [Test]
        public void Command_PendingRequestWinsOverStaleCompletedStatus()
        {
            TestStatusCompatCommand.HasPendingRequest = () => true;
            TestStatusCompatCommand.ReadOfficialStatus = () =>
                throw new AssertionException("Official status must not be read while a request is pending.");

            JObject result = TestStatusCompatCommand.GetTestStatus();

            Assert.That(result.Value<string>("status"), Is.EqualTo("running"));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
        }

        [Test]
        public void Command_RequestStartingDuringStatusReadWinsOverStaleCompletedStatus()
        {
            bool requestPending = false;
            TestStatusCompatCommand.HasPendingRequest = () => requestPending;
            TestStatusCompatCommand.ReadOfficialStatus = () =>
            {
                requestPending = true;
                return "{\"status\":\"completed\",\"summary\":{\"total\":1,\"passed\":1}}";
            };

            JObject result = TestStatusCompatCommand.GetTestStatus();

            Assert.That(result.Value<string>("status"), Is.EqualTo("running"));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
            Assert.That(result["summary"], Is.Null);
        }

        [Test]
        public void Command_RequestStartingDuringFailedStatusReadWinsOverReadError()
        {
            bool requestPending = false;
            TestStatusCompatCommand.HasPendingRequest = () => requestPending;
            TestStatusCompatCommand.ReadOfficialStatus = () =>
            {
                requestPending = true;
                throw new IOException("stale status disappeared");
            };

            JObject result = TestStatusCompatCommand.GetTestStatus();

            Assert.That(result.Value<string>("status"), Is.EqualTo("running"));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
            Assert.That(result.Value<string>("message"), Is.Null);
        }

        [Test]
        public void Command_OfficialReadFailureFailsClosedWithoutThrowing()
        {
            TestStatusCompatCommand.HasPendingRequest = () => false;
            TestStatusCompatCommand.ReadOfficialStatus = () =>
                throw new InvalidOperationException("read failed");

            JObject result = TestStatusCompatCommand.GetTestStatus();

            Assert.That(result.Value<string>("status"), Is.EqualTo("error"));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
            Assert.That(result.Value<string>("message"), Does.Contain("read failed"));
        }

        [Test]
        public void ParseOfficialStatus_PreservesCompletedPayloadAndOverwritesIsRunning()
        {
            JObject result = TestStatusCompatCommand.ParseOfficialStatus(
                "{\"status\":\"completed\",\"isRunning\":true," +
                "\"summary\":{\"total\":50,\"passed\":50,\"failed\":0}," +
                "\"results\":[{\"FullName\":\"Example\",\"Status\":\"Passed\"}]}");

            Assert.That(result.Value<string>("status"), Is.EqualTo("completed"));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
            Assert.That(result["summary"]?.Value<int>("total"), Is.EqualTo(50));
            Assert.That(result["summary"]?.Value<int>("passed"), Is.EqualTo(50));
            Assert.That(result["results"], Has.Count.EqualTo(1));
        }

        [TestCase("running")]
        [TestCase("in_progress")]
        [TestCase("cancelled")]
        [TestCase("error")]
        [TestCase("no_tests")]
        public void ParseOfficialStatus_PreservesKnownLifecycleStatus(string status)
        {
            JObject result = TestStatusCompatCommand.ParseOfficialStatus(
                $"{{\"status\":\"{status}\",\"message\":\"kept\"}}");

            Assert.That(result.Value<string>("status"), Is.EqualTo(status));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
            Assert.That(result.Value<string>("message"), Is.EqualTo("kept"));
        }

        [TestCase("")]
        [TestCase("null")]
        [TestCase("[]")]
        [TestCase("{}")]
        [TestCase("{\"status\":12}")]
        [TestCase("{\"status\":\"future_status\"}")]
        [TestCase("not-json")]
        public void ParseOfficialStatus_MalformedOrUnknownPayloadFailsClosed(string payload)
        {
            JObject result = TestStatusCompatCommand.ParseOfficialStatus(payload);

            Assert.That(result.Value<string>("status"), Is.EqualTo("error"));
            Assert.That(result.Value<bool>("isRunning"), Is.False);
            Assert.That(result.Value<string>("message"), Is.Not.Empty);
        }

        [Test]
        public void Discovery_PreservesOfficialRunTestsAndReplacesOnlyOfficialTestStatus()
        {
            MethodInfo officialRunTests = typeof(TestCommands)
                .GetMethod(nameof(TestCommands.RunTests));
            MethodInfo officialTestStatus = typeof(TestCommands)
                .GetMethod(nameof(TestCommands.GetTestStatus));
            MethodInfo compatTestStatus = typeof(TestStatusCompatCommand)
                .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus));
            var discovery = CreateDiscovery();

            MethodInfo[] discovered = discovery
                .GetMethodsWithAttribute<CliCommandAttribute>()
                .ToArray();

            Assert.That(discovery.InvariantSatisfied, Is.True, discovery.InvariantError);
            Assert.That(discovered.Count(RecompileStatusCompatDiscovery.HasRunTestsName), Is.EqualTo(1));
            Assert.That(discovered.Single(RecompileStatusCompatDiscovery.HasRunTestsName),
                Is.EqualTo(officialRunTests));
            CollectionAssert.DoesNotContain(discovered, officialTestStatus);
            Assert.That(discovered.Count(RecompileStatusCompatDiscovery.HasTestStatusName), Is.EqualTo(1));
            Assert.That(discovered.Single(RecompileStatusCompatDiscovery.HasTestStatusName),
                Is.EqualTo(compatTestStatus));
        }

        [Test]
        public void Discovery_MissingCompatTestStatusDisablesEveryProtectedCommand()
        {
            var discovery = CreateDiscovery(includeCompatTestStatus: false);

            MethodInfo[] discovered = discovery
                .GetMethodsWithAttribute<CliCommandAttribute>()
                .ToArray();

            Assert.That(discovery.InvariantSatisfied, Is.False);
            Assert.That(discovery.InvariantError, Does.Contain("test_status official=1, compat=0"));
            Assert.That(discovered.Any(RecompileStatusCompatDiscovery.HasProtectedCommandName), Is.False);
        }

        [Test]
        public void Discovery_DuplicateOfficialTestStatusDisablesEveryProtectedCommand()
        {
            var discovery = CreateDiscovery(duplicateOfficialTestStatus: true);

            MethodInfo[] discovered = discovery
                .GetMethodsWithAttribute<CliCommandAttribute>()
                .ToArray();

            Assert.That(discovery.InvariantSatisfied, Is.False);
            Assert.That(discovery.InvariantError, Does.Contain("test_status official=2"));
            Assert.That(discovered.Any(RecompileStatusCompatDiscovery.HasProtectedCommandName), Is.False);
        }

        [Test]
        public void DiscoveryPostcondition_RejectsOfficialTestStatusHandler()
        {
            RecompileStatusCompatDiscovery discovery = CreateSatisfiedDiscovery();
            CommandInfo officialTestStatus = CreateCommandInfo(
                typeof(TestCommands).GetMethod(nameof(TestCommands.GetTestStatus)));

            bool valid = RecompileStatusCompatStartupGate.TryValidateDiscoveryPostcondition(
                discovery,
                ExactPublishedCommands(testStatusOverride: officialTestStatus),
                out string error);

            Assert.That(valid, Is.False);
            Assert.That(error, Does.Contain("'test_status' command did not resolve"));
        }

        [Test]
        public void DiscoveryPostcondition_RejectsNonOfficialRunTestsHandler()
        {
            RecompileStatusCompatDiscovery discovery = CreateSatisfiedDiscovery();
            CommandInfo wrongRunTests = CreateCommandInfo(
                typeof(TestCommands).GetMethod(nameof(TestCommands.GetTestStatus)),
                "run_tests");

            bool valid = RecompileStatusCompatStartupGate.TryValidateDiscoveryPostcondition(
                discovery,
                ExactPublishedCommands(runTestsOverride: wrongRunTests),
                out string error);

            Assert.That(valid, Is.False);
            Assert.That(error, Does.Contain("'run_tests' command did not resolve"));
        }

        private static RecompileStatusCompatDiscovery CreateSatisfiedDiscovery()
        {
            RecompileStatusCompatDiscovery discovery = CreateDiscovery();
            discovery.GetMethodsWithAttribute<CliCommandAttribute>().ToArray();
            Assert.That(discovery.InvariantSatisfied, Is.True, discovery.InvariantError);
            return discovery;
        }

        private static CommandInfo[] ExactPublishedCommands(
            CommandInfo runTestsOverride = null,
            CommandInfo testStatusOverride = null)
        {
            return new[]
            {
                CreateCommandInfo(
                    typeof(RecompileCompatCommand)
                        .GetMethod(nameof(RecompileCompatCommand.Recompile))),
                CreateCommandInfo(
                    typeof(RecompileStatusCompatCommand)
                        .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus))),
                runTestsOverride ?? CreateCommandInfo(
                    typeof(TestCommands).GetMethod(nameof(TestCommands.RunTests))),
                testStatusOverride ?? CreateCommandInfo(
                    typeof(TestStatusCompatCommand)
                        .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus)))
            };
        }

        private static CommandInfo CreateCommandInfo(MethodInfo method, string commandName = null)
        {
            commandName = commandName ??
                          method?.GetCustomAttribute<CliCommandAttribute>()?.Name ??
                          string.Empty;
            return new CommandInfo(
                commandName,
                "test command",
                false,
                method,
                Array.Empty<CommandParameterInfo>());
        }

        private static RecompileStatusCompatDiscovery CreateDiscovery(
            bool includeCompatTestStatus = true,
            bool duplicateOfficialTestStatus = false)
        {
            var methods = new List<MethodInfo>
            {
                typeof(RecompileCommand).GetMethod(nameof(RecompileCommand.Recompile)),
                typeof(RecompileCommand).GetMethod(nameof(RecompileCommand.RecompileStatus)),
                typeof(RecompileCompatCommand).GetMethod(nameof(RecompileCompatCommand.Recompile)),
                typeof(RecompileStatusCompatCommand)
                    .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus)),
                typeof(TestCommands).GetMethod(nameof(TestCommands.RunTests)),
                typeof(TestCommands).GetMethod(nameof(TestCommands.GetTestStatus))
            };

            if (includeCompatTestStatus)
            {
                methods.Add(typeof(TestStatusCompatCommand)
                    .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus)));
            }

            if (duplicateOfficialTestStatus)
            {
                methods.Add(typeof(TestCommands).GetMethod(nameof(TestCommands.GetTestStatus)));
            }

            return new RecompileStatusCompatDiscovery(new FixedDiscovery(methods.ToArray()));
        }

        private sealed class FixedDiscovery : ICommandDiscovery
        {
            private readonly MethodInfo[] _methods;

            internal FixedDiscovery(params MethodInfo[] methods)
            {
                _methods = methods;
            }

            public IEnumerable<MethodInfo> GetMethodsWithAttribute<T>() where T : Attribute
            {
                return _methods.Where(method => method?.GetCustomAttribute<T>() != null);
            }
        }
    }
}
