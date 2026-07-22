using System;
using System.Collections.Generic;
using UnityEngine;

namespace Zamgune.UnityPipelineCompat
{
    internal sealed class StepLogCapture : IDisposable
    {
        private const int MaxEntries = 1000;
        private readonly object _gate = new object();
        private readonly List<ZamgunePlayLogEntry> _entries = new List<ZamgunePlayLogEntry>();
        private bool _started;

        internal void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            Application.logMessageReceivedThreaded += OnLogMessage;
        }

        internal ZamgunePlayLogEntry[] Snapshot()
        {
            lock (_gate)
            {
                return _entries.ToArray();
            }
        }

        public void Dispose()
        {
            if (!_started)
            {
                return;
            }

            Application.logMessageReceivedThreaded -= OnLogMessage;
            _started = false;
        }

        private void OnLogMessage(string condition, string stackTrace, LogType type)
        {
            lock (_gate)
            {
                if (_entries.Count >= MaxEntries)
                {
                    return;
                }

                _entries.Add(new ZamgunePlayLogEntry
                {
                    Message = condition,
                    StackTrace = stackTrace,
                    Type = type.ToString()
                });
            }
        }
    }
}
