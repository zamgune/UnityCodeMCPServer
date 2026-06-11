using System;
using System.IO;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityCodeMcpServer.Handlers;
using UnityCodeMcpServer.Helpers;
using UnityCodeMcpServer.Registry;
using UnityCodeMcpServer.Settings;
using UnityEditor;
using UnityEngine;

namespace UnityCodeMcpServer.FileServer
{
    [InitializeOnLoad]
    public static class UnityCodeMcpFileServer
    {
        // FileSystemWatcher (Mono) can silently miss events, especially on macOS.
        // A throttled rescan from EditorApplication.update guarantees pending
        // requests are picked up even when no watcher event arrives.
        private const double PollIntervalSeconds = 0.5;

        private static FileSystemWatcher _watcher;
        private static FileServerRequestStore _requestStore;
        private static McpRegistry _registry;
        private static McpMessageHandler _messageHandler;
        private static CancellationTokenSource _serverCts;
        private static int _isProcessing;
        private static double _nextPollTime;

        static UnityCodeMcpFileServer()
        {
            UnityCodeMcpServerLogger.Trace($"[UnityCodeMcpFileServer] Static constructor");
            if (Application.isBatchMode)
            {
                return;
            }

            EditorApplication.quitting += OnEditorQuitting;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
            AssemblyReloadEvents.afterAssemblyReload += OnAfterAssemblyReload;
        }

        private static void OnEditorQuitting()
        {
            StopServer("editor-quitting");
        }

        private static void OnBeforeAssemblyReload()
        {
            StopServer("assembly-reload");
        }

        [MenuItem("Tools/UnityCodeMcpServer/Restart Server")]
        public static void RestartServer()
        {
            StopServer("manual-restart");
            StartServer("manual-restart");
        }

        private static void OnAfterAssemblyReload()
        {
            UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] OnAfterAssemblyReload event");
            StartServer("assembly-reload");
        }

        private static void StopServer(string reason)
        {
            EditorApplication.update -= OnEditorUpdate;
            _serverCts?.Cancel();
            _serverCts?.Dispose();
            _serverCts = null;

            if (_watcher != null)
            {
                _watcher.EnableRaisingEvents = false;
                _watcher.Created -= OnRequestFileEvent;
                _watcher.Changed -= OnRequestFileEvent;
                _watcher.Renamed -= OnRequestFileRenamed;
                _watcher.Dispose();
                _watcher = null;
            }

            _requestStore = null;
            _messageHandler = null;
            _registry = null;
            Interlocked.Exchange(ref _isProcessing, 0);

            UnityCodeMcpServerLogger.Info($"[UnityCodeMcpFileServer] Server stopped reason={reason}");
        }

        private static void StartServer(string reason)
        {
            if (_watcher != null)
            {
                return;
            }

            try
            {
                string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
                string messagesDirectory = CreateMessagesDirectory(projectRoot);

                _registry = new McpRegistry();
                _registry.DiscoverAndRegisterAll();
                _messageHandler = new McpMessageHandler(_registry);
                _requestStore = new FileServerRequestStore(messagesDirectory);
                _serverCts = new CancellationTokenSource();
                _watcher = CreateWatcher(messagesDirectory);
                _watcher.EnableRaisingEvents = true;

                _nextPollTime = 0;
                EditorApplication.update += OnEditorUpdate;

                ProcessAvailableRequestsAsync(_requestStore, _messageHandler, _serverCts.Token).Forget();
                UnityCodeMcpServerLogger.Info($"[UnityCodeMcpFileServer] Server started directory={messagesDirectory} reason={reason}");
            }
            catch (Exception ex)
            {
                UnityCodeMcpServerLogger.Error($"[UnityCodeMcpFileServer] Failed to start server: {ex}");
                StopServer("start-failed");
            }
        }

        private static void OnRequestFileEvent(object sender, FileSystemEventArgs args)
        {
            if (!IsRequestFile(args.FullPath))
            {
                return;
            }

            UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] File watcher signaled change={args.ChangeType} path={args.FullPath}");
            ProcessAvailableRequestsAsync(_requestStore, _messageHandler, _serverCts?.Token ?? CancellationToken.None).Forget();
        }

        private static void OnRequestFileRenamed(object sender, RenamedEventArgs args)
        {
            if (!IsRequestFile(args.FullPath))
            {
                return;
            }

            UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] File watcher signaled rename old={args.OldFullPath} new={args.FullPath}");
            ProcessAvailableRequestsAsync(_requestStore, _messageHandler, _serverCts?.Token ?? CancellationToken.None).Forget();
        }

        private static void OnEditorUpdate()
        {
            if (EditorApplication.timeSinceStartup < _nextPollTime)
            {
                return;
            }

            _nextPollTime = EditorApplication.timeSinceStartup + PollIntervalSeconds;
            ProcessAvailableRequestsAsync(_requestStore, _messageHandler, _serverCts?.Token ?? CancellationToken.None).Forget();
        }

        private static bool IsRequestFile(string path)
        {
            string fileName = Path.GetFileName(path);
            return fileName != null
                && fileName.Contains("_request_", StringComparison.Ordinal)
                && fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase);
        }

        private static async UniTaskVoid ProcessAvailableRequestsAsync(
            FileServerRequestStore requestStore,
            McpMessageHandler messageHandler,
            CancellationToken ct)
        {
            if (requestStore == null || messageHandler == null)
            {
                return;
            }

            if (Interlocked.Exchange(ref _isProcessing, 1) == 1)
            {
                UnityCodeMcpServerLogger.Trace("[UnityCodeMcpFileServer] Skipping wake-up because processing is already active");
                return;
            }

            bool deferred = false;
            try
            {
                bool refreshAttempted = false;
                while (!ct.IsCancellationRequested)
                {
                    await UniTask.SwitchToMainThread(ct);

                    if (!refreshAttempted && requestStore.TryGetNextPendingRequest(out _))
                    {
                        refreshAttempted = true;
                        if (RefreshAssetDatabaseIfIdle())
                        {
                            // A refresh-triggered compilation may not be visible to
                            // isCompiling within the same frame, so yield one tick.
                            await UniTask.Yield();
                        }
                    }

                    if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                    {
                        // Leave pending request files on disk instead of answering with a
                        // "retry while compiling" error; the post-reload rescan (or the next
                        // poll tick) processes them against the freshly compiled assemblies.
                        UnityCodeMcpServerLogger.Debug("[UnityCodeMcpFileServer] Deferring pending requests until compilation finishes");
                        deferred = true;
                        break;
                    }

                    bool processed = await ProcessNextRequestAsync(requestStore, messageHandler, ct);
                    if (!processed)
                    {
                        UnityCodeMcpServerLogger.Trace("[UnityCodeMcpFileServer] No more pending file requests after rescan");
                        break;
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                UnityCodeMcpServerLogger.Error($"[UnityCodeMcpFileServer] Processing loop failed: {ex}");
            }
            finally
            {
                Interlocked.Exchange(ref _isProcessing, 0);

                if (!deferred && !ct.IsCancellationRequested && requestStore.TryGetNextPendingRequest(out _))
                {
                    UnityCodeMcpServerLogger.Debug("[UnityCodeMcpFileServer] Pending requests remain after processing loop, scheduling another pass");
                    ProcessAvailableRequestsAsync(requestStore, messageHandler, ct).Forget();
                }
            }
        }

        private static FileSystemWatcher CreateWatcher(string messagesDirectory)
        {
            FileSystemWatcher watcher = new(messagesDirectory, "*_request_*.json")
            {
                IncludeSubdirectories = false,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.CreationTime | NotifyFilters.LastWrite,
                EnableRaisingEvents = false,
            };
            watcher.Created += OnRequestFileEvent;
            watcher.Changed += OnRequestFileEvent;
            watcher.Renamed += OnRequestFileRenamed;
            UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] Created file watcher for directory={messagesDirectory}");
            return watcher;
        }

        // Unity only auto-refreshes the AssetDatabase when the editor window gains
        // focus, so scripts edited by an external agent would otherwise stay
        // uncompiled until the user clicks into Unity.
        private static bool RefreshAssetDatabaseIfIdle()
        {
            if (!UnityCodeMcpServerSettings.Instance.AutoRefreshAssetsOnRequest)
            {
                return false;
            }

            if (EditorApplication.isPlayingOrWillChangePlaymode
                || EditorApplication.isCompiling
                || EditorApplication.isUpdating)
            {
                return false;
            }

            UnityCodeMcpServerLogger.Debug("[UnityCodeMcpFileServer] Refreshing AssetDatabase before processing requests");
            AssetDatabase.Refresh();
            return true;
        }

        private static string CreateMessagesDirectory(string projectRoot)
        {
            string messagesDirectory = Path.Combine(projectRoot, ".unityCodeMcpServer", "messages");
            Directory.CreateDirectory(messagesDirectory);
            return messagesDirectory;
        }

        private static async UniTask<bool> ProcessNextRequestAsync(
            FileServerRequestStore requestStore,
            McpMessageHandler messageHandler,
            CancellationToken ct)
        {
            if (!requestStore.TryGetNextPendingRequest(out FileServerRequestFile request))
            {
                return false;
            }

            ct.ThrowIfCancellationRequested();
            UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] Processing request file request={request.RequestPath}");
            string requestJson = await ReadRequestAsync(request.RequestPath, ct);
            string responseJson = await ProcessRequestJsonAsync(messageHandler, requestJson, ct);
            if (responseJson != null)
            {
                await WriteAllTextAtomicallyAsync(request.ResponsePath, responseJson, request.RequestPath, ct);
                UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] Wrote response file response={request.ResponsePath}");
            }
            else
            {
                DeleteRequestFile(request.RequestPath);
                UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] Request was a notification with no response file request={request.RequestPath}");
            }

            return true;
        }

        private static async UniTask<string> ReadRequestAsync(
            string requestPath,
            CancellationToken ct)
        {
            return await File.ReadAllTextAsync(requestPath, ct);
        }

        private static async UniTask<string> ProcessRequestJsonAsync(
            McpMessageHandler messageHandler,
            string requestJson,
            CancellationToken ct)
        {
            await UniTask.SwitchToMainThread(ct);
            return await messageHandler.ProcessMessageAsync(requestJson);
        }

        private static void DeleteRequestFile(string requestPath)
        {
            if (!File.Exists(requestPath))
            {
                return;
            }

            File.Delete(requestPath);
            UnityCodeMcpServerLogger.Debug($"[UnityCodeMcpFileServer] Deleted request file request={requestPath}");
        }

        private static async UniTask WriteAllTextAtomicallyAsync(
            string path,
            string content,
            string requestPath,
            CancellationToken ct)
        {
            string temporaryPath = Path.Combine(
                Path.GetDirectoryName(path) ?? string.Empty,
                $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");

            try
            {
                await File.WriteAllTextAsync(temporaryPath, content, ct);

                if (File.Exists(path))
                {
                    File.Delete(path);
                }

                File.Move(temporaryPath, path);
                DeleteRequestFile(requestPath);
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }
    }
}
