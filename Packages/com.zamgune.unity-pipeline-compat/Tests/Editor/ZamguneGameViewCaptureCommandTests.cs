using System.Reflection;
using System.Threading.Tasks;
using NUnit.Framework;
using Unity.Pipeline.Commands;

namespace Zamgune.UnityPipelineCompat.Tests
{
    public class ZamguneGameViewCaptureCommandTests
    {
        [Test]
        public void Command_ExposesExpectedMetadataAndOnlyMaxHeightArgument()
        {
            MethodInfo capture = typeof(ZamguneGameViewCaptureCommand).GetMethod(
                nameof(ZamguneGameViewCaptureCommand.Capture));

            Assert.That(capture, Is.Not.Null);
            Assert.That(
                capture.GetCustomAttribute<CliCommandAttribute>()?.Name,
                Is.EqualTo("zamgune_capture_game_view"));
            Assert.That(
                capture.GetCustomAttribute<CliCommandAttribute>()?.MainThreadRequired,
                Is.True);
            Assert.That(
                capture.ReturnType,
                Is.EqualTo(typeof(Task<ZamguneGameViewCaptureResponse>)));

            ParameterInfo[] parameters = capture.GetParameters();
            Assert.That(parameters, Has.Length.EqualTo(1));
            Assert.That(parameters[0].DefaultValue, Is.EqualTo(640));

            CliArgAttribute argument = parameters[0].GetCustomAttribute<CliArgAttribute>();
            Assert.That(argument, Is.Not.Null);
            Assert.That(argument.Name, Is.EqualTo("max_height"));
            Assert.That(argument.Required, Is.False);
            Assert.That(argument.DefaultValue, Is.EqualTo(640));
        }

        [Test]
        public void Response_ExposesRequiredCapturePayload()
        {
            TypeInfo response = typeof(ZamguneGameViewCaptureResponse).GetTypeInfo();

            Assert.That(response.GetProperty("Success"), Is.Not.Null);
            Assert.That(response.GetProperty("Error"), Is.Not.Null);
            Assert.That(response.GetProperty("Base64"), Is.Not.Null);
            Assert.That(response.GetProperty("Width"), Is.Not.Null);
            Assert.That(response.GetProperty("Height"), Is.Not.Null);
            Assert.That(response.GetProperty("Bytes"), Is.Not.Null);
            Assert.That(response.GetProperty("Source"), Is.Not.Null);
        }

        [TestCase(0, "between 1")]
        [TestCase(1, null)]
        [TestCase(640, null)]
        [TestCase(4096, null)]
        [TestCase(4097, "4096")]
        public void ValidateMaxHeight_EnforcesInclusiveRange(
            int maxHeight,
            string expectedMessageFragment)
        {
            string error = ZamguneGameViewCaptureCommand.ValidateMaxHeight(maxHeight);

            if (expectedMessageFragment == null)
            {
                Assert.That(error, Is.Null);
            }
            else
            {
                StringAssert.Contains(expectedMessageFragment, error);
            }
        }

        [TestCase(1920, 1080, 640, 1137, 640)]
        [TestCase(800, 600, 640, 800, 600)]
        [TestCase(1, 10000, 1, 1, 1)]
        [TestCase(0, 0, 640, 1, 1)]
        public void GetScaledDimensions_PreservesAspectRatioWithoutUpscaling(
            int width,
            int height,
            int maxHeight,
            int expectedWidth,
            int expectedHeight)
        {
            ZamguneGameViewCaptureCommand.GetScaledDimensionsToMaxHeight(
                width,
                height,
                maxHeight,
                out int scaledWidth,
                out int scaledHeight);

            Assert.That(scaledWidth, Is.EqualTo(expectedWidth));
            Assert.That(scaledHeight, Is.EqualTo(expectedHeight));
        }
    }
}
