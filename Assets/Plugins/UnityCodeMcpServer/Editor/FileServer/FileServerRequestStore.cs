using System;
using System.IO;
using System.Linq;
using UnityCodeMcpServer.Helpers;

namespace UnityCodeMcpServer.FileServer
{
    public readonly struct FileServerRequestFile
    {
        public FileServerRequestFile(string requestPath, string responsePath, string timestamp, string clientId)
        {
            RequestPath = requestPath;
            ResponsePath = responsePath;
            Timestamp = timestamp;
            ClientId = clientId;
        }

        public string RequestPath { get; }

        public string ResponsePath { get; }

        public string Timestamp { get; }

        public string ClientId { get; }
    }

    public sealed class FileServerRequestStore
    {
        // A reload can kill the server between writing a temporary response file
        // and moving it into place, and a crashed bridge leaves its request and
        // response files behind. Both kinds of leftovers accumulate forever
        // unless swept on server start.
        private static readonly TimeSpan StaleMessageAge = TimeSpan.FromHours(1);
        private static readonly TimeSpan StaleTempFileAge = TimeSpan.FromMinutes(5);

        private readonly string _messagesDirectory;

        public FileServerRequestStore(string messagesDirectory)
        {
            _messagesDirectory = messagesDirectory ?? throw new ArgumentNullException(nameof(messagesDirectory));
        }

        public string EnsureMessagesDirectory()
        {
            Directory.CreateDirectory(_messagesDirectory);
            UnityCodeMcpServerLogger.Debug($"[FileServerRequestStore] Ensured messages directory path={_messagesDirectory}");
            return _messagesDirectory;
        }

        public void CleanupStaleFiles()
        {
            EnsureMessagesDirectory();
            DateTime utcNow = DateTime.UtcNow;
            DeleteFilesOlderThan("*.tmp", utcNow - StaleTempFileAge);
            DeleteFilesOlderThan("*_request_*.json", utcNow - StaleMessageAge);
            DeleteFilesOlderThan("*_response_*.json", utcNow - StaleMessageAge);
        }

        private void DeleteFilesOlderThan(string pattern, DateTime cutoffUtc)
        {
            foreach (string path in Directory.GetFiles(_messagesDirectory, pattern))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(path) >= cutoffUtc)
                    {
                        continue;
                    }

                    File.Delete(path);
                    UnityCodeMcpServerLogger.Info($"[FileServerRequestStore] Deleted stale message file path={path}");
                }
                catch (IOException ex)
                {
                    UnityCodeMcpServerLogger.Warn($"[FileServerRequestStore] Failed to delete stale message file path={path} error={ex.Message}");
                }
            }
        }

        public bool TryGetNextPendingRequest(out FileServerRequestFile request)
        {
            EnsureMessagesDirectory();

            foreach (string requestPath in Directory
                .GetFiles(_messagesDirectory, "*_request_*.json")
                .OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                string fileName = Path.GetFileNameWithoutExtension(requestPath);
                if (!TryParseRequestFileName(fileName, out string timestamp, out string clientId))
                {
                    UnityCodeMcpServerLogger.Warn($"[FileServerRequestStore] Ignoring request file with unexpected name path={requestPath}");
                    continue;
                }

                string responsePath = Path.Combine(
                    _messagesDirectory,
                    $"{timestamp}_response_{clientId}.json");
                if (File.Exists(responsePath))
                {
                    UnityCodeMcpServerLogger.Debug($"[FileServerRequestStore] Skipping request with existing response request={requestPath} response={responsePath}");
                    continue;
                }

                request = new FileServerRequestFile(requestPath, responsePath, timestamp, clientId);
                UnityCodeMcpServerLogger.Debug($"[FileServerRequestStore] Selected next request request={request.RequestPath} response={request.ResponsePath}");
                return true;
            }

            UnityCodeMcpServerLogger.Trace($"[FileServerRequestStore] No pending request found directory={_messagesDirectory}");
            request = default;
            return false;
        }

        private static bool TryParseRequestFileName(string fileName, out string timestamp, out string clientId)
        {
            timestamp = null;
            clientId = null;

            if (string.IsNullOrEmpty(fileName))
            {
                return false;
            }

            int requestMarkerIndex = fileName.IndexOf("_request_", StringComparison.Ordinal);
            if (requestMarkerIndex <= 0)
            {
                return false;
            }

            timestamp = fileName.Substring(0, requestMarkerIndex);
            clientId = fileName.Substring(requestMarkerIndex + "_request_".Length);
            return !string.IsNullOrEmpty(timestamp) && !string.IsNullOrEmpty(clientId);
        }
    }
}
