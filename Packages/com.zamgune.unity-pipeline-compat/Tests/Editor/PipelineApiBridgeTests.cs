using System.Collections;
using System.Linq;
using NUnit.Framework;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEngine.TestTools;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public class PipelineApiBridgeTests
    {
        private bool lifecycle_prepared;

        [UnityTest]
        [Explicit("Enters the current saved scene ten times; back up project runtime saves before running.")]
        [Category("PipelineLifecycle")]
        public IEnumerator ProtectedCommandsSurviveTenFastPlayCycles()
        {
            Assert.That(EditorSettings.enterPlayModeOptionsEnabled, Is.True);
            Assert.That(EditorSettings.enterPlayModeOptions.HasFlag(EnterPlayModeOptions.DisableDomainReload), Is.True);
            lifecycle_prepared = true;
            for (int cycle = 1; cycle <= 10; cycle++)
            {
                yield return new EnterPlayMode(expectDomainReload: false);
                RegistryRetainsExactlyOneProtectedCommandOfEachKind();
                TypeCacheRetainsUnrelatedCommands();
                yield return new ExitPlayMode();
                RegistryRetainsExactlyOneProtectedCommandOfEachKind();
                TypeCacheRetainsUnrelatedCommands();
            }
        }

        [UnityTearDown]
        public IEnumerator RestoreEditModeAfterLifecycleTest()
        {
            if (lifecycle_prepared && EditorApplication.isPlayingOrWillChangePlaymode)
                yield return new ExitPlayMode();
            lifecycle_prepared = false;
        }

        [Test]
        public void OfficialCommandSignaturesRemainSupported()
        {
            var compile = PipelineApiBridge.EditorType("Commands.RecompileCommand").GetMethod("Recompile");
            Assert.That(compile, Is.Not.Null);
            Assert.That(compile.GetParameters().Select(p => p.ParameterType), Is.EqualTo(new[] { typeof(bool) }));
            var status = PipelineApiBridge.EditorType("Commands.TestCommands").GetMethod("GetTestStatus");
            Assert.That(status, Is.Not.Null);
            Assert.That(status.ReturnType, Is.EqualTo(typeof(string)));
        }

        [Test]
        public void RegistryRetainsExactlyOneProtectedCommandOfEachKind()
        {
            var commands = PipelineApiBridge.DiscoverCommands().ToArray();
            foreach (var name in new[] { "recompile", "recompile_status", "run_tests", "test_status" })
                Assert.That(commands.Count(command => command.Name == name), Is.EqualTo(1), name);
            Assert.That(commands.Single(command => command.Name == "recompile").Method.DeclaringType, Is.EqualTo(typeof(RecompileCompatCommand)));
            Assert.That(commands.Single(command => command.Name == "recompile_status").Method.DeclaringType, Is.EqualTo(typeof(RecompileStatusCompatCommand)));
            Assert.That(commands.Single(command => command.Name == "test_status").Method.DeclaringType, Is.EqualTo(typeof(TestStatusCompatCommand)));
        }

        [Test]
        public void StartupSettingsRemainExplicitlyGuarded()
        {
            Assert.That(RecompileStatusCompatStartupGate.TryValidateSettingsAsset(out string error), Is.True, error);
            var settings = PipelineApiBridge.LoadSettings(RecompileStatusCompatBootstrapPolicy.CanonicalSettingsPath);
            Assert.That(PipelineApiBridge.IsSettingsObject(settings), Is.True);
            Assert.That(PipelineApiBridge.AutoStart(settings), Is.False);
        }

        [Test]
        public void TypeCacheRetainsUnrelatedCommands()
        {
            var source = new CompatTypeCacheCommandDiscovery().GetMethodsWithAttribute<CliCommandAttribute>()
                .Where(method => !RecompileStatusCompatDiscovery.HasProtectedCommandName(method)).ToArray();
            var actual = PipelineApiBridge.DiscoverCommands().Select(command => command.Method).ToArray();
            Assert.That(source.Length, Is.GreaterThan(0));
            Assert.That(actual, Is.SupersetOf(source));
        }
    }
}
