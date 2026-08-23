using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using Unity.Pipeline.Commands;
using UnityEngine;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public sealed class BuildEnvironmentStatusCommandTests
    {
        [Test]
        public void Command_IsAnExplicitMainThreadSafeRead()
        {
            MethodInfo method = typeof(BuildEnvironmentStatusCommand)
                .GetMethod(nameof(BuildEnvironmentStatusCommand.GetStatus));
            CliCommandAttribute attribute = method?.GetCustomAttribute<CliCommandAttribute>();

            Assert.That(method, Is.Not.Null);
            Assert.That(attribute, Is.Not.Null);
            Assert.That(attribute.Name, Is.EqualTo("zamgune_build_environment_status"));
            Assert.That(attribute.MainThreadRequired, Is.True);
            Assert.That(method.ReturnType, Is.EqualTo(typeof(JObject)));
        }

        [Test]
        public void Status_UsesStableSchemaAndStringEncodedEntityIds()
        {
            JObject status = BuildEnvironmentStatusCommand.GetStatus();

            Assert.That(status.Value<int>("schemaVersion"), Is.EqualTo(1));
            Assert.That(status.Value<string>("unityVersion"), Is.EqualTo(Application.unityVersion));
            Assert.That(status.Value<string>("projectPath"), Is.Not.Empty);
            Assert.That(status.Value<int>("editorPid"), Is.GreaterThan(0));
            Assert.That(status.Value<string>("entityIdEncoding"),
                Is.EqualTo("uint64-decimal-string"));
            Assert.That(status["targetSupport"], Is.TypeOf<JArray>());
            Assert.That((JArray)status["targetSupport"], Has.Count.EqualTo(3));
            Assert.That(status["buildProfiles"], Is.TypeOf<JArray>());
            Assert.That(status["installedPlatformModules"], Is.TypeOf<JArray>());

#if UNITY_6000_5_OR_NEWER
            Assert.That(status.Value<bool>("buildProfileApisAvailable"), Is.True);
            foreach (JObject profile in status["buildProfiles"].OfType<JObject>())
            {
                Assert.That(profile.Value<string>("entityId"), Does.Match("^[0-9]+$"));
                Assert.That(profile["scenes"], Is.TypeOf<JArray>());
                Assert.That(profile["scriptingDefines"], Is.TypeOf<JArray>());
            }
#else
            Assert.That(status.Value<bool>("buildProfileApisAvailable"), Is.False);
            Assert.That(status.Value<string>("buildProfileApisUnavailableReason"), Is.Not.Empty);
#endif
        }
    }
}
