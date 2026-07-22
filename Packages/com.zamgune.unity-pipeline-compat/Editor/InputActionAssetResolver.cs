using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine.InputSystem;

namespace Zamgune.UnityPipelineCompat
{
    internal static class InputActionAssetResolver
    {
        internal static InputActionAsset Load(
            string requestedPath,
            out string resolvedPath,
            out string warning)
        {
            warning = null;

            if (!string.IsNullOrWhiteSpace(requestedPath))
            {
                resolvedPath = requestedPath.Trim().Replace("\\", "/");
                InputActionAsset requestedAsset =
                    AssetDatabase.LoadAssetAtPath<InputActionAsset>(resolvedPath);
                if (requestedAsset == null)
                {
                    throw new ArgumentException(
                        $"No InputActionAsset exists at '{resolvedPath}'.",
                        nameof(requestedPath));
                }

                return requestedAsset;
            }

            IReadOnlyList<string> projectPaths = FindPaths(new[] { "Assets" });
            IReadOnlyList<string> allPaths = FindPaths(Array.Empty<string>());
            resolvedPath = ResolvePath(requestedPath, projectPaths, allPaths, out warning);

            if (string.IsNullOrEmpty(resolvedPath))
            {
                throw new InvalidOperationException(
                    "No InputActionAsset was found. Supply input_action_asset_path or add an InputActionAsset under Assets.");
            }

            return AssetDatabase.LoadAssetAtPath<InputActionAsset>(resolvedPath);
        }

        internal static string ResolvePath(
            string requestedPath,
            IReadOnlyList<string> projectPaths,
            IReadOnlyList<string> allPaths,
            out string warning)
        {
            warning = null;
            if (!string.IsNullOrWhiteSpace(requestedPath))
            {
                return requestedPath.Trim().Replace("\\", "/");
            }

            string projectPath = FirstSorted(projectPaths);
            if (!string.IsNullOrEmpty(projectPath))
            {
                warning = $"input_action_asset_path was omitted; using project InputActionAsset '{projectPath}'.";
                return projectPath;
            }

            string fallbackPath = FirstSorted(allPaths);
            if (!string.IsNullOrEmpty(fallbackPath))
            {
                warning = $"input_action_asset_path was omitted; using fallback InputActionAsset '{fallbackPath}'.";
                return fallbackPath;
            }

            return null;
        }

        private static IReadOnlyList<string> FindPaths(string[] searchFolders)
        {
            string[] guids = searchFolders == null || searchFolders.Length == 0
                ? AssetDatabase.FindAssets("t:InputActionAsset")
                : AssetDatabase.FindAssets("t:InputActionAsset", searchFolders);

            return guids
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        private static string FirstSorted(IReadOnlyList<string> paths)
        {
            return paths == null
                ? null
                : paths
                    .Where(path => !string.IsNullOrWhiteSpace(path))
                    .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
        }
    }
}
