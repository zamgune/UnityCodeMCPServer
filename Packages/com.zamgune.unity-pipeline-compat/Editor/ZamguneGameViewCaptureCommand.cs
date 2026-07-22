using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Zamgune.UnityPipelineCompat
{
    public static class ZamguneGameViewCaptureCommand
    {
        internal const int DefaultMaxHeight = 640;
        internal const int MaximumMaxHeight = 4096;

        private const string CaptureSource = "gameView:ScreenCapture.CaptureScreenshot";
        private static readonly TimeSpan CaptureTimeout = TimeSpan.FromSeconds(5);

        [CliCommand(
            "zamgune_capture_game_view",
            "Capture the final composed Play Mode Game View, including Screen Space Overlay UI, as a PNG.",
            MainThreadRequired = true)]
        public static async Task<ZamguneGameViewCaptureResponse> Capture(
            [CliArg(
                "max_height",
                "Maximum returned PNG height. Larger captures are scaled proportionally (default 640; maximum 4096).",
                DefaultValue = DefaultMaxHeight)] int maxHeight = DefaultMaxHeight)
        {
            string validationError = ValidateMaxHeight(maxHeight);
            if (!string.IsNullOrEmpty(validationError))
            {
                return ZamguneGameViewCaptureResponse.Fail(CaptureSource, validationError);
            }

            if (!EditorApplication.isPlaying)
            {
                return ZamguneGameViewCaptureResponse.Fail(
                    CaptureSource,
                    "Unity must be in Play Mode to capture the final composed Game View.");
            }

            string temporaryDirectory = null;
            string temporaryPath = null;
            try
            {
                temporaryDirectory = CreateTemporaryCaptureDirectory();
                temporaryPath = Path.Combine(temporaryDirectory, "game-view.png");

                RepaintGameView();
                ScreenCapture.CaptureScreenshot(temporaryPath, 1);

                return await WaitForScreenshotResponseAsync(
                        temporaryPath,
                        maxHeight,
                        CaptureTimeout)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                return ZamguneGameViewCaptureResponse.Fail(
                    CaptureSource,
                    $"Failed to capture the final composed Game View: {ex.Message}");
            }
            finally
            {
                DeleteTemporaryCapture(temporaryPath, temporaryDirectory);
            }
        }

        internal static string ValidateMaxHeight(int maxHeight)
        {
            if (maxHeight < 1 || maxHeight > MaximumMaxHeight)
            {
                return $"max_height must be between 1 and {MaximumMaxHeight} inclusive.";
            }

            return null;
        }

        internal static void GetScaledDimensionsToMaxHeight(
            int width,
            int height,
            int maxHeight,
            out int scaledWidth,
            out int scaledHeight)
        {
            if (width <= 0 || height <= 0 || maxHeight <= 0)
            {
                scaledWidth = 1;
                scaledHeight = 1;
                return;
            }

            if (height <= maxHeight)
            {
                scaledWidth = width;
                scaledHeight = height;
                return;
            }

            double scale = (double)maxHeight / height;
            scaledWidth = Math.Max(1, (int)Math.Floor(width * scale));
            scaledHeight = maxHeight;
        }

        private static ZamguneGameViewCaptureResponse BuildResponse(byte[] sourcePng, int maxHeight)
        {
            var sourceTexture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            try
            {
                if (!sourceTexture.LoadImage(sourcePng, false))
                {
                    return ZamguneGameViewCaptureResponse.Fail(
                        CaptureSource,
                        "Unity returned screenshot bytes that could not be decoded as PNG.");
                }

                GetScaledDimensionsToMaxHeight(
                    sourceTexture.width,
                    sourceTexture.height,
                    maxHeight,
                    out int outputWidth,
                    out int outputHeight);

                byte[] outputPng = sourceTexture.width == outputWidth && sourceTexture.height == outputHeight
                    ? sourcePng
                    : ScaleTextureToPng(sourceTexture, outputWidth, outputHeight);

                if (outputPng == null || outputPng.Length == 0)
                {
                    return ZamguneGameViewCaptureResponse.Fail(
                        CaptureSource,
                        "Failed to encode the captured Game View as PNG.");
                }

                return ZamguneGameViewCaptureResponse.Ok(
                    CaptureSource,
                    outputPng,
                    outputWidth,
                    outputHeight);
            }
            finally
            {
                Object.DestroyImmediate(sourceTexture);
            }
        }

        private static byte[] ScaleTextureToPng(Texture2D sourceTexture, int width, int height)
        {
            RenderTexture previousRenderTexture = RenderTexture.active;
            RenderTexture temporaryRenderTexture = null;
            Texture2D scaledTexture = null;
            try
            {
                temporaryRenderTexture = RenderTexture.GetTemporary(
                    width,
                    height,
                    0,
                    RenderTextureFormat.ARGB32);
                Graphics.Blit(sourceTexture, temporaryRenderTexture);
                RenderTexture.active = temporaryRenderTexture;

                scaledTexture = new Texture2D(width, height, TextureFormat.RGB24, false);
                scaledTexture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                scaledTexture.Apply(false, false);
                return scaledTexture.EncodeToPNG();
            }
            finally
            {
                RenderTexture.active = previousRenderTexture;

                if (temporaryRenderTexture != null)
                {
                    RenderTexture.ReleaseTemporary(temporaryRenderTexture);
                }

                if (scaledTexture != null)
                {
                    Object.DestroyImmediate(scaledTexture);
                }
            }
        }

        private static Task<ZamguneGameViewCaptureResponse> WaitForScreenshotResponseAsync(
            string path,
            int maxHeight,
            TimeSpan timeout)
        {
            var completion = new TaskCompletionSource<ZamguneGameViewCaptureResponse>();
            var completionGate = new object();
            long previousLength = -1;
            bool completed = false;
            Timer timeoutTimer = null;
            EditorApplication.CallbackFunction updateCallback = null;

            void Complete(ZamguneGameViewCaptureResponse response)
            {
                lock (completionGate)
                {
                    if (completed)
                    {
                        return;
                    }

                    completed = true;
                }

                try
                {
                    EditorApplication.update -= updateCallback;
                }
                catch
                {
                    // The response timeout must still complete if the Editor is tearing down.
                }
                finally
                {
                    timeoutTimer?.Dispose();
                }

                completion.TrySetResult(response);
            }

            updateCallback = () =>
            {
                if (!EditorApplication.isPlaying)
                {
                    Complete(ZamguneGameViewCaptureResponse.Fail(
                        CaptureSource,
                        "The Editor left Play Mode while capturing the Game View."));
                    return;
                }

                try
                {
                    if (File.Exists(path))
                    {
                        long currentLength = new FileInfo(path).Length;
                        if (currentLength > 0 && currentLength == previousLength)
                        {
                            byte[] bytes = File.ReadAllBytes(path);
                            if (bytes.LongLength == currentLength)
                            {
                                Complete(BuildResponse(bytes, maxHeight));
                                return;
                            }
                        }

                        previousLength = currentLength;
                    }
                }
                catch (IOException)
                {
                    // ScreenCapture can still have the file open; poll again on the next Editor update.
                }
                catch (UnauthorizedAccessException)
                {
                    // Treat a transient file lock like an incomplete capture and poll again.
                }
                catch (Exception ex)
                {
                    Complete(ZamguneGameViewCaptureResponse.Fail(
                        CaptureSource,
                        $"Failed while reading the captured Game View: {ex.Message}"));
                }
            };

            EditorApplication.update += updateCallback;
            timeoutTimer = new Timer(
                _ => Complete(ZamguneGameViewCaptureResponse.Fail(
                    CaptureSource,
                    $"Game View screenshot was not ready within {timeout.TotalSeconds:0} seconds.")),
                null,
                timeout,
                Timeout.InfiniteTimeSpan);
            updateCallback();

            return completion.Task;
        }

        private static string CreateTemporaryCaptureDirectory()
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string directory = Path.Combine(
                projectRoot,
                "Temp",
                $"ZamguneGameViewCapture-{Guid.NewGuid():N}");
            Directory.CreateDirectory(directory);
            return directory;
        }

        private static void DeleteTemporaryCapture(string path, string directory)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path))
                {
                    File.Delete(path);
                }

                if (!string.IsNullOrEmpty(directory) &&
                    Directory.Exists(directory) &&
                    Directory.GetFileSystemEntries(directory).Length == 0)
                {
                    Directory.Delete(directory);
                }
            }
            catch
            {
                // Cleanup is best effort and must not replace the capture result with a secondary error.
            }
        }

        private static void RepaintGameView()
        {
            Type gameViewType = Type.GetType("UnityEditor.GameView, UnityEditor");
            if (gameViewType == null)
            {
                return;
            }

            EditorWindow gameView = EditorWindow.GetWindow(gameViewType);
            gameView?.Repaint();
        }
    }

    [Serializable]
    public sealed class ZamguneGameViewCaptureResponse
    {
        public bool Success { get; set; }
        public string Error { get; set; }
        public string Base64 { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int Bytes { get; set; }
        public string Source { get; set; }

        internal static ZamguneGameViewCaptureResponse Ok(
            string source,
            byte[] png,
            int width,
            int height)
        {
            return new ZamguneGameViewCaptureResponse
            {
                Success = true,
                Base64 = Convert.ToBase64String(png),
                Width = width,
                Height = height,
                Bytes = png.Length,
                Source = source
            };
        }

        internal static ZamguneGameViewCaptureResponse Fail(string source, string error)
        {
            return new ZamguneGameViewCaptureResponse
            {
                Success = false,
                Error = error,
                Source = source
            };
        }
    }
}
