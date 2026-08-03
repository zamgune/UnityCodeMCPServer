using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using Unity.Pipeline.Commands;
using Unity.Pipeline.Editor.Commands;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public class RecompileStatusCompatTests
    {
        [TearDown]
        public void TearDown()
        {
            RecompileCompatCommand.ResetTestHooks();
        }

        [Test]
        public void RecompileCommand_PreservesOfficialDefaultsAndAddsOptInForce()
        {
            MethodInfo method = typeof(RecompileCompatCommand)
                .GetMethod(nameof(RecompileCompatCommand.Recompile));
            CliCommandAttribute attribute = method?.GetCustomAttribute<CliCommandAttribute>();
            ParameterInfo[] parameters = method?.GetParameters();

            Assert.That(method, Is.Not.Null);
            Assert.That(attribute, Is.Not.Null);
            Assert.That(attribute.Name, Is.EqualTo("recompile"));
            Assert.That(attribute.MainThreadRequired, Is.True);
            Assert.That(parameters, Has.Length.EqualTo(2));
            Assert.That(parameters[0].Name, Is.EqualTo("focus"));
            Assert.That(parameters[0].DefaultValue, Is.False);
            Assert.That(parameters[1].Name, Is.EqualTo("force"));
            Assert.That(parameters[1].DefaultValue, Is.False);
        }

        [Test]
        public void RecompileCommand_DefaultPathDelegatesWithoutForcing()
        {
            var officialResult = new object();
            bool? observedFocus = null;
            int requestCount = 0;
            int persistCount = 0;
            RecompileCompatCommand.OfficialRecompile = focus =>
            {
                observedFocus = focus;
                return officialResult;
            };
            RecompileCompatCommand.IsCompiling = () => false;
            RecompileCompatCommand.RequestCleanCompilation = () => requestCount++;
            RecompileCompatCommand.PersistStatus = (_, __, ___) => persistCount++;

            object result = RecompileCompatCommand.Recompile(focus: true, force: false);

            Assert.That(result, Is.SameAs(officialResult));
            Assert.That(observedFocus, Is.True);
            Assert.That(requestCount, Is.Zero);
            Assert.That(persistCount, Is.Zero);
        }

        [Test]
        public void RecompileCommand_ForceReturnsTriggeredWhenCompilationIsNotObservedAfterRequest()
        {
            var events = new List<string>();
            RecompileCompatCommand.OfficialRecompile = _ => new object();
            RecompileCompatCommand.IsCompiling = () =>
            {
                events.Add("observe-compiling:False");
                return false;
            };
            RecompileCompatCommand.PersistStatus = (status, failed, errors) =>
                events.Add($"persist:{status}:{failed}:{errors.Length}");
            RecompileCompatCommand.RequestCleanCompilation = () => events.Add("request-clean");

            var result = (JObject)RecompileCompatCommand.Recompile(focus: false, force: true);

            CollectionAssert.AreEqual(
                new[]
                {
                    "observe-compiling:False",
                    "persist:triggered:False:0",
                    "request-clean",
                    "observe-compiling:False"
                },
                events);
            Assert.That(result.Value<string>("status"), Is.EqualTo("triggered"));
            Assert.That(result.Value<bool>("failed"), Is.False);
            Assert.That(result.Value<bool>("isCompiling"), Is.False);
            Assert.That(result.Value<bool>("forced"), Is.True);
        }

        [Test]
        public void RecompileCommand_ForceReturnsCompilingOnlyWhenObservedAfterRequest()
        {
            var events = new List<string>();
            int observationCount = 0;
            RecompileCompatCommand.OfficialRecompile = _ => new object();
            RecompileCompatCommand.IsCompiling = () =>
            {
                bool isCompiling = observationCount++ > 0;
                events.Add($"observe-compiling:{isCompiling}");
                return isCompiling;
            };
            RecompileCompatCommand.PersistStatus = (status, failed, errors) =>
                events.Add($"persist:{status}:{failed}:{errors.Length}");
            RecompileCompatCommand.RequestCleanCompilation = () => events.Add("request-clean");

            var result = (JObject)RecompileCompatCommand.Recompile(focus: false, force: true);

            CollectionAssert.AreEqual(
                new[]
                {
                    "observe-compiling:False",
                    "persist:triggered:False:0",
                    "request-clean",
                    "observe-compiling:True"
                },
                events);
            Assert.That(result.Value<string>("status"), Is.EqualTo("compiling"));
            Assert.That(result.Value<bool>("failed"), Is.False);
            Assert.That(result.Value<bool>("isCompiling"), Is.True);
            Assert.That(result.Value<bool>("forced"), Is.True);
        }

        [Test]
        public void RecompileCommand_ForceDoesNotDoubleRequestWhenOfficialRefreshAlreadyCompiles()
        {
            var officialResult = new object();
            int requestCount = 0;
            int persistCount = 0;
            RecompileCompatCommand.OfficialRecompile = _ => officialResult;
            RecompileCompatCommand.IsCompiling = () => true;
            RecompileCompatCommand.RequestCleanCompilation = () => requestCount++;
            RecompileCompatCommand.PersistStatus = (_, __, ___) => persistCount++;

            object result = RecompileCompatCommand.Recompile(focus: false, force: true);

            Assert.That(result, Is.SameAs(officialResult));
            Assert.That(requestCount, Is.Zero);
            Assert.That(persistCount, Is.Zero);
        }

        [Test]
        public void RecompileCommand_StatusPersistenceFailureNeverRequestsCompilation()
        {
            int requestCount = 0;
            RecompileCompatCommand.OfficialRecompile = _ => new object();
            RecompileCompatCommand.IsCompiling = () => false;
            RecompileCompatCommand.PersistStatus = (_, __, ___) =>
                throw new InvalidOperationException("disk unavailable");
            RecompileCompatCommand.RequestCleanCompilation = () => requestCount++;

            var result = (JObject)RecompileCompatCommand.Recompile(focus: false, force: true);

            Assert.That(requestCount, Is.Zero);
            Assert.That(result.Value<string>("status"), Is.EqualTo("error"));
            Assert.That(result.Value<bool>("failed"), Is.True);
            Assert.That(result["errors"]?.Values<string>().Single(), Does.Contain("disk unavailable"));
        }

        [Test]
        public void RecompileCommand_RequestFailurePersistsTerminalFailureWithoutRetry()
        {
            var persisted = new List<(string status, bool failed, string[] errors)>();
            int requestCount = 0;
            RecompileCompatCommand.OfficialRecompile = _ => new object();
            RecompileCompatCommand.IsCompiling = () => false;
            RecompileCompatCommand.PersistStatus = (status, failed, errors) =>
                persisted.Add((status, failed, errors));
            RecompileCompatCommand.RequestCleanCompilation = () =>
            {
                requestCount++;
                throw new InvalidOperationException("request rejected");
            };

            var result = (JObject)RecompileCompatCommand.Recompile(focus: false, force: true);

            Assert.That(requestCount, Is.EqualTo(1));
            Assert.That(persisted.Select(entry => entry.status),
                Is.EqualTo(new[] { "triggered", "completed" }));
            Assert.That(persisted.Last().failed, Is.True);
            Assert.That(persisted.Last().errors.Single(), Does.Contain("request rejected"));
            Assert.That(result.Value<string>("status"), Is.EqualTo("error"));
        }

        [Test]
        public void Command_ExposesStructuredBackgroundSafeContract()
        {
            MethodInfo method = typeof(RecompileStatusCompatCommand)
                .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus));
            CliCommandAttribute attribute = method?.GetCustomAttribute<CliCommandAttribute>();

            Assert.That(method, Is.Not.Null);
            Assert.That(method.ReturnType, Is.EqualTo(typeof(JObject)));
            Assert.That(attribute, Is.Not.Null);
            Assert.That(attribute.Name, Is.EqualTo("recompile_status"));
            Assert.That(attribute.MainThreadRequired, Is.False);
        }

        [TestCase("triggered", false)]
        [TestCase("compiling", true)]
        [TestCase("completed", false)]
        [TestCase("up_to_date", false)]
        public void ParseOfficialStatus_DerivesCompilingOnlyFromPersistedStatus(
            string status,
            bool expectedIsCompiling)
        {
            JObject result = RecompileStatusCompatCommand.ParseOfficialStatus(
                $"{{\"status\":\"{status}\",\"failed\":false,\"errors\":[]}}");

            Assert.That(result.Value<string>("status"), Is.EqualTo(status));
            Assert.That(result.Value<bool>("isCompiling"), Is.EqualTo(expectedIsCompiling));
        }

        [Test]
        public void ParseOfficialStatus_PreservesCompilationErrors()
        {
            JObject result = RecompileStatusCompatCommand.ParseOfficialStatus(
                "{\"status\":\"completed\",\"failed\":true," +
                "\"errors\":[\"Assets/A.cs(1,2): error CS1002\",\"second error\"]}");

            Assert.That(result.Value<string>("status"), Is.EqualTo("completed"));
            Assert.That(result.Value<bool>("failed"), Is.True);
            Assert.That(result.Value<bool>("isCompiling"), Is.False);
            CollectionAssert.AreEqual(
                new[] { "Assets/A.cs(1,2): error CS1002", "second error" },
                result["errors"]?.Values<string>().ToArray());
        }

        [Test]
        public void NoFileIdleResult_IsTheOnlySafeIdleContract()
        {
            JObject result = RecompileStatusCompatCommand.NoFileIdleResult();

            Assert.That(result.Value<string>("status"), Is.EqualTo("idle"));
            Assert.That(result["failed"]?.Type, Is.EqualTo(JTokenType.Boolean));
            Assert.That(result.Value<bool>("failed"), Is.False);
            Assert.That(result["errors"]?.Type, Is.EqualTo(JTokenType.Array));
            Assert.That((JArray)result["errors"], Is.Empty);
            Assert.That(result.Value<bool>("isCompiling"), Is.False);
        }

        [TestCase("")]
        [TestCase("not-json")]
        [TestCase("{\"status\":\"future_status\"}")]
        [TestCase("{\"status\":\"idle\",\"failed\":false,\"errors\":[]}")]
        public void ParseOfficialStatus_FailsClosedForMalformedOrUnknownPayload(string payload)
        {
            JObject result = RecompileStatusCompatCommand.ParseOfficialStatus(payload);

            Assert.That(result.Value<string>("status"), Is.EqualTo("error"));
            Assert.That(result.Value<bool>("failed"), Is.True);
            Assert.That(result.Value<bool>("isCompiling"), Is.False);
            Assert.That((JArray)result["errors"], Is.Not.Empty);
        }

        [TestCase("{\"status\":\"completed\",\"errors\":[]}")]
        [TestCase("{\"status\":\"completed\",\"failed\":null,\"errors\":[]}")]
        [TestCase("{\"status\":\"completed\",\"failed\":\"false\",\"errors\":[]}")]
        [TestCase("{\"status\":\"completed\",\"failed\":false}")]
        [TestCase("{\"status\":\"completed\",\"failed\":false,\"errors\":null}")]
        [TestCase("{\"status\":\"completed\",\"failed\":false,\"errors\":{}}")]
        [TestCase("{\"status\":\"completed\",\"failed\":false,\"errors\":[null]}")]
        public void ParseOfficialStatus_FailsClosedWhenRequiredFieldsAreNotExact(string payload)
        {
            JObject result = RecompileStatusCompatCommand.ParseOfficialStatus(payload);

            Assert.That(result.Value<string>("status"), Is.EqualTo("error"));
            Assert.That(result.Value<bool>("failed"), Is.True);
            Assert.That(result.Value<bool>("isCompiling"), Is.False);
            Assert.That((JArray)result["errors"], Is.Not.Empty);
        }

        [Test]
        public void Discovery_ReplacesOfficialTriggerAndStatusWithOneCompatPair()
        {
            MethodInfo officialStatus = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.RecompileStatus));
            MethodInfo officialRecompile = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.Recompile));
            MethodInfo compatRecompile = typeof(RecompileCompatCommand)
                .GetMethod(nameof(RecompileCompatCommand.Recompile));
            MethodInfo compatStatus = typeof(RecompileStatusCompatCommand)
                .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus));
            var discovery = new RecompileStatusCompatDiscovery(
                WithExactTestContract(
                    officialStatus,
                    officialRecompile,
                    compatRecompile,
                    compatStatus));

            MethodInfo[] discovered = discovery
                .GetMethodsWithAttribute<CliCommandAttribute>()
                .ToArray();

            Assert.That(discovery.InvariantEvaluated, Is.True);
            Assert.That(discovery.InvariantSatisfied, Is.True);
            CollectionAssert.DoesNotContain(discovered, officialRecompile);
            CollectionAssert.DoesNotContain(discovered, officialStatus);
            Assert.That(discovered.Count(RecompileStatusCompatDiscovery.HasRecompileName), Is.EqualTo(1));
            Assert.That(discovered.Single(RecompileStatusCompatDiscovery.HasRecompileName),
                Is.EqualTo(compatRecompile));
            Assert.That(discovered.Count(RecompileStatusCompatDiscovery.HasRecompileStatusName), Is.EqualTo(1));
            Assert.That(discovered.Single(RecompileStatusCompatDiscovery.HasRecompileStatusName), Is.EqualTo(compatStatus));
        }

        [Test]
        public void Discovery_DisablesTriggerAndStatusWhenOfficialIdentityIsMissing()
        {
            MethodInfo officialRecompile = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.Recompile));
            MethodInfo compatRecompile = typeof(RecompileCompatCommand)
                .GetMethod(nameof(RecompileCompatCommand.Recompile));
            MethodInfo compatStatus = typeof(RecompileStatusCompatCommand)
                .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus));
            var discovery = new RecompileStatusCompatDiscovery(
                WithExactTestContract(officialRecompile, compatRecompile, compatStatus));

            MethodInfo[] discovered = discovery
                .GetMethodsWithAttribute<CliCommandAttribute>()
                .ToArray();

            Assert.That(discovery.InvariantSatisfied, Is.False);
            Assert.That(discovery.InvariantError, Does.Contain("status official=0"));
            Assert.That(discovered.Any(RecompileStatusCompatDiscovery.HasRecompileName), Is.False);
            Assert.That(discovered.Any(RecompileStatusCompatDiscovery.HasRecompileStatusName), Is.False);
        }

        [Test]
        public void Discovery_DisablesTriggerAndStatusWhenAnyCandidateIsDuplicated()
        {
            MethodInfo officialStatus = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.RecompileStatus));
            MethodInfo officialRecompile = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.Recompile));
            MethodInfo compatRecompile = typeof(RecompileCompatCommand)
                .GetMethod(nameof(RecompileCompatCommand.Recompile));
            MethodInfo compatStatus = typeof(RecompileStatusCompatCommand)
                .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus));
            var discovery = new RecompileStatusCompatDiscovery(
                WithExactTestContract(
                    officialStatus,
                    officialStatus,
                    officialRecompile,
                    compatRecompile,
                    compatStatus));

            MethodInfo[] discovered = discovery
                .GetMethodsWithAttribute<CliCommandAttribute>()
                .ToArray();

            Assert.That(discovery.InvariantSatisfied, Is.False);
            Assert.That(discovery.InvariantError, Does.Contain("status official=2"));
            Assert.That(discovered.Any(RecompileStatusCompatDiscovery.HasRecompileName), Is.False);
            Assert.That(discovered.Any(RecompileStatusCompatDiscovery.HasRecompileStatusName), Is.False);
        }

        [Test]
        public void StartupGate_RequiresExactlyOneAutoStartFalseSettingsAsset()
        {
            bool valid = RecompileStatusCompatStartupGate.TryValidateSettingsAsset(
                out string[] discoveredSettingsPaths,
                out string error);

            Assert.That(valid, Is.True, error);
            Assert.That(discoveredSettingsPaths, Has.Length.EqualTo(1));
        }

        [TestCase(
            (int)RecompileStatusCompatBootstrapState.Uninitialized,
            true,
            false,
            false,
            false)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.DisabledAwaitingImport,
            true,
            false,
            false,
            true)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.DisabledAwaitingImport,
            false,
            true,
            false,
            true)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.DisabledAwaitingImport,
            false,
            false,
            true,
            true)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.DisabledAwaitingImport,
            false,
            false,
            false,
            false)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.RunningCompat,
            false,
            true,
            false,
            true)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.RunningCompat,
            false,
            false,
            true,
            true)]
        [TestCase(
            (int)RecompileStatusCompatBootstrapState.RunningCompat,
            false,
            false,
            false,
            false)]
        public void BootstrapPolicy_RunsPhaseBOnlyForBoundedRelevantEvents(
            int state,
            bool didDomainReload,
            bool hasManagerEvent,
            bool hasKnownSettingsPathEvent,
            bool expected)
        {
            bool actual = RecompileStatusCompatBootstrapPolicy.ShouldRunPhaseB(
                (RecompileStatusCompatBootstrapState)state,
                didDomainReload,
                hasManagerEvent,
                hasKnownSettingsPathEvent);

            Assert.That(actual, Is.EqualTo(expected));
        }

        [Test]
        public void BootstrapPolicy_RecognizesExactAndChangedParentFolderCoverage()
        {
            const string knownCustomPath = "Assets/Automation/PipelineSettings.asset";
            string canonicalPath = RecompileStatusCompatBootstrapPolicy.CanonicalSettingsPath;

            Assert.That(
                RecompileStatusCompatBootstrapPolicy.IsCanonicalSettingsPath(
                    canonicalPath),
                Is.True);
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                    new[] { canonicalPath },
                    new[] { canonicalPath, knownCustomPath }),
                Is.True);
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                    new[] { "Assets/Settings" },
                    new[] { canonicalPath }),
                Is.True);
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.IsSameOrAncestorPath(
                    "Assets\\Settings",
                    canonicalPath),
                Is.True);
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                    new[] { "Assets/Automation/" },
                    new[] { knownCustomPath }),
                Is.True);
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                    new[] { "Assets/Auto" },
                    new[] { knownCustomPath }),
                Is.False);
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.AnyChangedPathCoversProtectedPath(
                    new[] { knownCustomPath + "/Child" },
                    new[] { knownCustomPath }),
                Is.False);
        }

        [TestCase(true, true, false, false, true)]
        [TestCase(true, false, true, false, true)]
        [TestCase(true, false, false, true, true)]
        [TestCase(true, false, false, false, false)]
        [TestCase(false, true, true, true, false)]
        public void BootstrapPolicy_ClassifiesOnlyManagerAssetPropertyChanges(
            bool isChangeAssetObjectProperties,
            bool instanceIsManager,
            bool guidMatchesKnown,
            bool guidResolvesToManager,
            bool expected)
        {
            bool actual = RecompileStatusCompatBootstrapPolicy.IsRelevantObjectPropertyChange(
                isChangeAssetObjectProperties,
                instanceIsManager,
                guidMatchesKnown,
                guidResolvesToManager);

            Assert.That(actual, Is.EqualTo(expected));
        }

        [TestCase(true, 1, true)]
        [TestCase(true, 2, true)]
        [TestCase(true, 0, false)]
        [TestCase(false, 1, false)]
        public void BootstrapPolicy_ClassifiesImportedOrMovedManagerFolders(
            bool isFolder,
            int managerCount,
            bool expected)
        {
            Assert.That(
                RecompileStatusCompatBootstrapPolicy.IsImportedOrMovedManagerFolder(
                    isFolder,
                    managerCount),
                Is.EqualTo(expected));
        }

        [Test]
        public void DiscoveryPostcondition_AcceptsExactlyOneCompatPair()
        {
            RecompileStatusCompatDiscovery discovery = CreateSatisfiedDiscovery();
            CommandInfo compatRecompile = CreateCommandInfo(
                typeof(RecompileCompatCommand)
                    .GetMethod(nameof(RecompileCompatCommand.Recompile)));
            CommandInfo compatStatus = CreateCommandInfo(
                typeof(RecompileStatusCompatCommand)
                    .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus)));
            CommandInfo officialRunTests = CreateCommandInfo(
                typeof(TestCommands).GetMethod(nameof(TestCommands.RunTests)));
            CommandInfo compatTestStatus = CreateCommandInfo(
                typeof(TestStatusCompatCommand)
                    .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus)));

            bool valid = RecompileStatusCompatStartupGate.TryValidateDiscoveryPostcondition(
                discovery,
                new[] { compatRecompile, compatStatus, officialRunTests, compatTestStatus },
                out string error);

            Assert.That(valid, Is.True, error);
        }

        [Test]
        public void DiscoveryPostcondition_RejectsWrongHandler()
        {
            RecompileStatusCompatDiscovery discovery = CreateSatisfiedDiscovery();
            CommandInfo compatRecompile = CreateCommandInfo(
                typeof(RecompileCompatCommand)
                    .GetMethod(nameof(RecompileCompatCommand.Recompile)));
            CommandInfo officialStatus = CreateCommandInfo(
                typeof(RecompileCommand).GetMethod(nameof(RecompileCommand.RecompileStatus)));
            CommandInfo officialRunTests = CreateCommandInfo(
                typeof(TestCommands).GetMethod(nameof(TestCommands.RunTests)));
            CommandInfo compatTestStatus = CreateCommandInfo(
                typeof(TestStatusCompatCommand)
                    .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus)));

            bool valid = RecompileStatusCompatStartupGate.TryValidateDiscoveryPostcondition(
                discovery,
                new[] { compatRecompile, officialStatus, officialRunTests, compatTestStatus },
                out string error);

            Assert.That(valid, Is.False);
            Assert.That(error, Does.Contain("did not resolve"));
        }

        [Test]
        public void DiscoveryPostcondition_RejectsDuplicateHandlers()
        {
            RecompileStatusCompatDiscovery discovery = CreateSatisfiedDiscovery();
            CommandInfo compatRecompile = CreateCommandInfo(
                typeof(RecompileCompatCommand)
                    .GetMethod(nameof(RecompileCompatCommand.Recompile)));
            CommandInfo compatStatus = CreateCommandInfo(
                typeof(RecompileStatusCompatCommand)
                    .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus)));
            CommandInfo officialRunTests = CreateCommandInfo(
                typeof(TestCommands).GetMethod(nameof(TestCommands.RunTests)));
            CommandInfo compatTestStatus = CreateCommandInfo(
                typeof(TestStatusCompatCommand)
                    .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus)));

            bool valid = RecompileStatusCompatStartupGate.TryValidateDiscoveryPostcondition(
                discovery,
                new[]
                {
                    compatRecompile,
                    compatStatus,
                    compatStatus,
                    officialRunTests,
                    compatTestStatus
                },
                out string error);

            Assert.That(valid, Is.False);
            Assert.That(error, Does.Contain("2 registered 'recompile_status'"));
        }

        private static RecompileStatusCompatDiscovery CreateSatisfiedDiscovery()
        {
            MethodInfo officialStatus = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.RecompileStatus));
            MethodInfo officialRecompile = typeof(RecompileCommand)
                .GetMethod(nameof(RecompileCommand.Recompile));
            MethodInfo compatRecompile = typeof(RecompileCompatCommand)
                .GetMethod(nameof(RecompileCompatCommand.Recompile));
            MethodInfo compatStatus = typeof(RecompileStatusCompatCommand)
                .GetMethod(nameof(RecompileStatusCompatCommand.RecompileStatus));
            var discovery = new RecompileStatusCompatDiscovery(
                WithExactTestContract(
                    officialStatus,
                    officialRecompile,
                    compatRecompile,
                    compatStatus));

            discovery.GetMethodsWithAttribute<CliCommandAttribute>().ToArray();
            Assert.That(discovery.InvariantSatisfied, Is.True, discovery.InvariantError);
            return discovery;
        }

        private static FixedDiscovery WithExactTestContract(params MethodInfo[] methods)
        {
            MethodInfo officialRunTests = typeof(TestCommands)
                .GetMethod(nameof(TestCommands.RunTests));
            MethodInfo officialTestStatus = typeof(TestCommands)
                .GetMethod(nameof(TestCommands.GetTestStatus));
            MethodInfo compatTestStatus = typeof(TestStatusCompatCommand)
                .GetMethod(nameof(TestStatusCompatCommand.GetTestStatus));

            return new FixedDiscovery(
                methods.Concat(new[]
                {
                    officialRunTests,
                    officialTestStatus,
                    compatTestStatus
                }).ToArray());
        }

        private static CommandInfo CreateCommandInfo(MethodInfo method)
        {
            string commandName = method == null
                ? string.Empty
                : method.GetCustomAttribute<CliCommandAttribute>()?.Name ?? string.Empty;
            return new CommandInfo(
                commandName,
                "test command",
                false,
                method,
                Array.Empty<CommandParameterInfo>());
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
