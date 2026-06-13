using UnityCodeMcpServer.Settings;
using UnityEditor;
using UnityEngine;

namespace UnityCodeMcpServer.Helpers
{
    /// <summary>
    /// Keeps the editor ticking while it is unfocused during Play Mode.
    ///
    /// Without runInBackground, Unity stops the player loop (and EditorApplication.update)
    /// when the editor goes to the background in Play Mode. That freezes the MCP file
    /// server too, so requests issued from another application (e.g. an AI agent running
    /// in a terminal) hang until the editor regains focus.
    ///
    /// Setting <see cref="Application.runInBackground"/> at runtime affects only the
    /// current play session — it does NOT modify PlayerSettings or builds.
    /// </summary>
    [InitializeOnLoad]
    public static class PlayModeBackgroundKeeper
    {
        static PlayModeBackgroundKeeper()
        {
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;

            // Covers the case where the server's domain reloads while already in Play Mode.
            if (EditorApplication.isPlaying)
            {
                Apply();
            }
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredPlayMode)
            {
                Apply();
            }
        }

        private static void Apply()
        {
            if (Application.isBatchMode)
            {
                return;
            }

            if (!UnityCodeMcpServerSettings.Instance.RunInBackgroundDuringPlayMode)
            {
                return;
            }

            if (Application.runInBackground)
            {
                return;
            }

            Application.runInBackground = true;
            UnityCodeMcpServerLogger.Info(
                "[PlayModeBackgroundKeeper] Enabled Application.runInBackground for this play session so MCP requests are serviced while the editor is unfocused.");
        }
    }
}
