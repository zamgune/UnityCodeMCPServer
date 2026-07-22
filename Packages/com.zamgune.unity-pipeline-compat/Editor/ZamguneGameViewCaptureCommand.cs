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
        private static readonly TimeSpan LateCaptureCleanupObservation = TimeSpan.FromSeconds(30);

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
            bool captureRequested = false;
            CaptureWaitResult waitResult = null;
            try
            {
                temporaryDirectory = CreateTemporaryCaptureDirectory();
                temporaryPath = Path.Combine(temporaryDirectory, "game-view.png");

                RepaintGameView();
                ScreenCapture.CaptureScreenshot(temporaryPath, 1);
                captureRequested = true;

                waitResult = await WaitForScreenshotResponseAsync(
                        temporaryPath,
                        temporaryDirectory,
                        maxHeight,
                        CaptureTimeout)
                    .ConfigureAwait(false);
                return waitResult.Response;
            }
            catch (Exception ex)
            {
                return ZamguneGameViewCaptureResponse.Fail(
                    CaptureSource,
                    $"Failed to capture the final composed Game View: {ex.Message}");
            }
            finally
            {
                // A timed-out ScreenCapture request can still write after this command returns.
                // Its Editor-update observer owns cleanup until the PNG is complete. If setup
                // failed before ScreenCapture was requested, or the wait consumed a complete PNG,
                // there is no possible late writer and cleanup is safe here.
                if (!captureRequested || waitResult?.SourceSettled == true)
                {
                    TryDeleteTemporaryCapture(temporaryPath, temporaryDirectory);
                }
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

        internal static bool HasCompletePngEnvelope(byte[] sourcePng)
        {
            if (sourcePng == null || sourcePng.Length < 20)
            {
                return false;
            }

            int end = sourcePng.Length - 12;
            return sourcePng[0] == 0x89 &&
                   sourcePng[1] == 0x50 &&
                   sourcePng[2] == 0x4E &&
                   sourcePng[3] == 0x47 &&
                   sourcePng[4] == 0x0D &&
                   sourcePng[5] == 0x0A &&
                   sourcePng[6] == 0x1A &&
                   sourcePng[7] == 0x0A &&
                   sourcePng[end] == 0x00 &&
                   sourcePng[end + 1] == 0x00 &&
                   sourcePng[end + 2] == 0x00 &&
                   sourcePng[end + 3] == 0x00 &&
                   sourcePng[end + 4] == 0x49 &&
                   sourcePng[end + 5] == 0x45 &&
                   sourcePng[end + 6] == 0x4E &&
                   sourcePng[end + 7] == 0x44 &&
                   sourcePng[end + 8] == 0xAE &&
                   sourcePng[end + 9] == 0x42 &&
                   sourcePng[end + 10] == 0x60 &&
                   sourcePng[end + 11] == 0x82;
        }

        internal static bool TryBuildResponse(
            byte[] sourcePng,
            int maxHeight,
            out ZamguneGameViewCaptureResponse response)
        {
            response = null;
            if (!HasCompletePngEnvelope(sourcePng))
            {
                return false;
            }

            var sourceTexture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            try
            {
                if (!sourceTexture.LoadImage(sourcePng, false))
                {
                    // A writer can expose a stable file length before the image decoder can consume
                    // it. Keep polling until the capture timeout instead of returning a false
                    // terminal failure.
                    return false;
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
                    response = ZamguneGameViewCaptureResponse.Fail(
                        CaptureSource,
                        "Failed to encode the captured Game View as PNG.");
                    return true;
                }

                response = ZamguneGameViewCaptureResponse.Ok(
                    CaptureSource,
                    outputPng,
                    outputWidth,
                    outputHeight);
                return true;
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

        private static Task<CaptureWaitResult> WaitForScreenshotResponseAsync(
            string path,
            string directory,
            int maxHeight,
            TimeSpan timeout)
        {
            int editorMainThreadId = Thread.CurrentThread.ManagedThreadId;
            var completion = new TaskCompletionSource<CaptureWaitResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            long previousLength = -1;
            int completionState = 0;
            DateTime? lateCleanupDeadlineUtc = null;
            Timer timeoutTimer = null;
            EditorApplication.CallbackFunction updateCallback = null;

            void UnsubscribeOnEditorMainThread()
            {
                if (Thread.CurrentThread.ManagedThreadId != editorMainThreadId)
                {
                    return;
                }

                EditorApplication.update -= updateCallback;
            }

            void TryComplete(
                ZamguneGameViewCaptureResponse response,
                bool sourceSettled,
                bool invokedFromEditorUpdate)
            {
                bool wonCompletion = Interlocked.CompareExchange(ref completionState, 1, 0) == 0;

                // Only the Editor update path may touch the EditorApplication event. If the timer
                // wins or Play Mode ends before the file settles, the callback stays registered as
                // a bounded late-write observer. It deletes only a complete PNG; otherwise it
                // leaves the staging path intact for a ScreenCapture request that may still write.
                if (invokedFromEditorUpdate && sourceSettled)
                {
                    UnsubscribeOnEditorMainThread();
                }

                if (!wonCompletion)
                {
                    if (invokedFromEditorUpdate && sourceSettled)
                    {
                        TryDeleteTemporaryCapture(path, directory);
                    }

                    return;
                }

                timeoutTimer?.Dispose();
                completion.TrySetResult(new CaptureWaitResult(response, sourceSettled));
            }

            bool TryCleanupLateCapture()
            {
                try
                {
                    if (!File.Exists(path))
                    {
                        return false;
                    }

                    long currentLength = new FileInfo(path).Length;
                    if (currentLength <= 0 || currentLength != previousLength)
                    {
                        previousLength = currentLength;
                        return false;
                    }

                    byte[] bytes = File.ReadAllBytes(path);
                    if (bytes.LongLength != currentLength || !HasCompletePngEnvelope(bytes))
                    {
                        return false;
                    }

                    return TryDeleteTemporaryCapture(path, directory);
                }
                catch (IOException)
                {
                    return false;
                }
                catch (UnauthorizedAccessException)
                {
                    return false;
                }
                catch
                {
                    // Cleanup observation is best effort. Keep the staging path intact and let the
                    // bounded observer unsubscribe at its deadline instead of surfacing an Editor
                    // update exception after the command has already returned.
                    return false;
                }
            }

            updateCallback = () =>
            {
                if (Thread.CurrentThread.ManagedThreadId != editorMainThreadId)
                {
                    return;
                }

                if (Volatile.Read(ref completionState) != 0)
                {
                    DateTime nowUtc = DateTime.UtcNow;
                    if (!lateCleanupDeadlineUtc.HasValue)
                    {
                        lateCleanupDeadlineUtc = nowUtc + LateCaptureCleanupObservation;
                    }

                    if (TryCleanupLateCapture() || nowUtc >= lateCleanupDeadlineUtc.Value)
                    {
                        UnsubscribeOnEditorMainThread();
                    }

                    return;
                }

                if (!EditorApplication.isPlaying)
                {
                    TryComplete(
                        ZamguneGameViewCaptureResponse.Fail(
                            CaptureSource,
                            "The Editor left Play Mode while capturing the Game View."),
                        sourceSettled: false,
                        invokedFromEditorUpdate: true);
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
                            if (bytes.LongLength == currentLength &&
                                TryBuildResponse(bytes, maxHeight, out ZamguneGameViewCaptureResponse response))
                            {
                                TryComplete(
                                    response,
                                    sourceSettled: true,
                                    invokedFromEditorUpdate: true);
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
                    TryComplete(
                        ZamguneGameViewCaptureResponse.Fail(
                            CaptureSource,
                            $"Failed while reading the captured Game View: {ex.Message}"),
                        sourceSettled: false,
                        invokedFromEditorUpdate: true);
                }
            };

            EditorApplication.update += updateCallback;
            timeoutTimer = new Timer(
                _ => TryComplete(
                    ZamguneGameViewCaptureResponse.Fail(
                        CaptureSource,
                        $"Game View screenshot was not ready within {timeout.TotalSeconds:0} seconds."),
                    sourceSettled: false,
                    invokedFromEditorUpdate: false),
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

        private static bool TryDeleteTemporaryCapture(string path, string directory)
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

                return string.IsNullOrEmpty(path) || !File.Exists(path);
            }
            catch
            {
                // Cleanup is best effort and must not replace the capture result with a secondary error.
                return false;
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

        private sealed class CaptureWaitResult
        {
            public CaptureWaitResult(ZamguneGameViewCaptureResponse response, bool sourceSettled)
            {
                Response = response;
                SourceSettled = sourceSettled;
            }

            public ZamguneGameViewCaptureResponse Response { get; }
            public bool SourceSettled { get; }
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
