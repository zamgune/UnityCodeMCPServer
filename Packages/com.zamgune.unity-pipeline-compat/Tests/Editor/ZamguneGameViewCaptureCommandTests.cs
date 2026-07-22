using System;
using System.Reflection;
using System.Threading.Tasks;
using NUnit.Framework;
using Unity.Pipeline.Commands;
using UnityEngine;
using Object = UnityEngine.Object;

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

        [Test]
        public void TryBuildResponse_CompletePngReturnsPayload()
        {
            byte[] png = CreateTestPng();

            bool settled = ZamguneGameViewCaptureCommand.TryBuildResponse(
                png,
                640,
                out ZamguneGameViewCaptureResponse response);

            Assert.That(settled, Is.True);
            Assert.That(response, Is.Not.Null);
            Assert.That(response.Success, Is.True);
            Assert.That(response.Width, Is.EqualTo(2));
            Assert.That(response.Height, Is.EqualTo(2));
            Assert.That(response.Bytes, Is.EqualTo(png.Length));
            Assert.That(Convert.FromBase64String(response.Base64), Is.EqualTo(png));
        }

        [Test]
        public void TryBuildResponse_StableButIncompletePngRemainsPending()
        {
            byte[] png = CreateTestPng();
            Array.Resize(ref png, png.Length - 1);

            bool settled = ZamguneGameViewCaptureCommand.TryBuildResponse(
                png,
                640,
                out ZamguneGameViewCaptureResponse response);

            Assert.That(settled, Is.False);
            Assert.That(response, Is.Null);
            Assert.That(ZamguneGameViewCaptureCommand.HasCompletePngEnvelope(png), Is.False);
        }

        [Test]
        public void HasCompletePngEnvelope_RejectsInvalidBytesWithPngEndMarker()
        {
            byte[] invalid =
            {
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
                0xAE, 0x42, 0x60, 0x82
            };

            Assert.That(ZamguneGameViewCaptureCommand.HasCompletePngEnvelope(invalid), Is.False);
        }

        [Test]
        public void TryBuildResponse_CompleteEnvelopeButUndecodablePngRemainsPending()
        {
            byte[] undecodable =
            {
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
                0xAE, 0x42, 0x60, 0x82
            };

            bool settled = ZamguneGameViewCaptureCommand.TryBuildResponse(
                undecodable,
                640,
                out ZamguneGameViewCaptureResponse response);

            Assert.That(ZamguneGameViewCaptureCommand.HasCompletePngEnvelope(undecodable), Is.True);
            Assert.That(settled, Is.False);
            Assert.That(response, Is.Null);
        }

        private static byte[] CreateTestPng()
        {
            var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            try
            {
                texture.SetPixels(new[]
                {
                    Color.magenta,
                    Color.cyan,
                    Color.yellow,
                    Color.black
                });
                texture.Apply(false, false);
                return texture.EncodeToPNG();
            }
            finally
            {
                Object.DestroyImmediate(texture);
            }
        }
    }
}
