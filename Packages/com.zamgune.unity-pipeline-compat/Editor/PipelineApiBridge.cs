using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.CompilerServices;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEngine;

namespace Zamgune.UnityPipelineCompat
{
    // Pipeline 0.6 made its discovery and startup types internal. Keep that dependency
    // in one checked adapter; never modify the registry package or its PackageCache.
    internal interface ICompatCommandDiscovery
    {
        IEnumerable<MethodInfo> GetMethodsWithAttribute<T>() where T : Attribute;
    }

    internal sealed class CompatTypeCacheCommandDiscovery : ICompatCommandDiscovery
    {
        public IEnumerable<MethodInfo> GetMethodsWithAttribute<T>() where T : Attribute
        {
            return TypeCache.GetMethodsWithAttribute<T>();
        }
    }

    internal static class PipelineApiBridge
    {
        private const BindingFlags static_flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        private const BindingFlags instance_flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        internal static Type EditorType(string name)
        {
            return Type.GetType("Unity.Pipeline.Editor." + name + ", Unity.Pipeline.Editor", true);
        }

        private static Type RegistryType => typeof(CliCommandAttribute).Assembly.GetType("Unity.Pipeline.Commands.CommandRegistry", true);
        private static Type StartupType => EditorType("PipelineServerStartup");

        private static object Invoke(Type type, string method, params object[] arguments)
        {
            var target = type.GetMethod(method, static_flags)
                ?? throw new MissingMethodException(type.FullName, method);
            try
            {
                return target.Invoke(null, arguments);
            }
            catch (TargetInvocationException exception) when (exception.InnerException != null)
            {
                ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
                throw;
            }
        }

        internal static object Recompile(bool focus)
        {
            return Invoke(EditorType("Commands.RecompileCommand"), "Recompile", focus);
        }

        internal static string TestStatus()
        {
            return (string)Invoke(EditorType("Commands.TestCommands"), "GetTestStatus");
        }

        internal static void InitializeStartup()
        {
            RuntimeHelpers.RunClassConstructor(StartupType.TypeHandle);
        }

        internal static void StartServer() => Invoke(StartupType, "EnsureServerStarted");
        internal static void StopServer() => Invoke(StartupType, "StopServer");

        internal static bool IsServerRunning
        {
            get
            {
                var property = StartupType.GetProperty("Server", static_flags)
                    ?? throw new MissingMemberException(StartupType.FullName, "Server");
                var server = property.GetValue(null);
                if (server == null) return false;
                var running = server.GetType().GetProperty("IsRunning", instance_flags)
                    ?? throw new MissingMemberException(server.GetType().FullName, "IsRunning");
                return (bool)running.GetValue(server);
            }
        }

        internal static bool IsSettingsObject(UnityEngine.Object asset)
        {
            return asset != null && EditorType("EditorPipelineManager").IsInstanceOfType(asset);
        }

        internal static UnityEngine.Object LoadSettings(string path)
        {
            return AssetDatabase.LoadAssetAtPath(path, EditorType("EditorPipelineManager"));
        }

        internal static bool AutoStart(UnityEngine.Object settings)
        {
            var property = EditorType("EditorPipelineManager").GetProperty("AutoStart", instance_flags)
                ?? throw new MissingMemberException("EditorPipelineManager", "AutoStart");
            return (bool)property.GetValue(settings);
        }

        internal static IEnumerable<CommandInfo> DiscoverCommands()
        {
            return (IEnumerable<CommandInfo>)Invoke(RegistryType, "DiscoverCommands");
        }

        internal static void SetDiscovery(ICompatCommandDiscovery discovery)
        {
            if (discovery == null) throw new ArgumentNullException(nameof(discovery));
            // The server is stopped during bootstrap. Build official metadata first, then
            // atomically publish only the methods admitted by the existing invariant.
            // The cache is replaced again after Play transitions, when 0.6 resets discovery.
            var methods = new HashSet<MethodInfo>(discovery.GetMethodsWithAttribute<CliCommandAttribute>());
            var registry = RegistryType;
            var cache = registry.GetField("m_CachedCommands", static_flags)
                ?? throw new MissingFieldException(registry.FullName, "m_CachedCommands");
            if (!cache.FieldType.IsAssignableFrom(typeof(List<CommandInfo>)))
                throw new InvalidOperationException("Unsupported Pipeline command cache contract.");
            var officialDiscovery = Activator.CreateInstance(EditorType("TypeCacheCommandDiscovery"), true);
            Invoke(registry, "SetDiscovery", officialDiscovery);
            var commands = DiscoverCommands().Where(command => methods.Contains(command.Method)).ToList();
            if (commands.Select(command => command.Method).Distinct().Count() != methods.Count)
                throw new InvalidOperationException("Pipeline omitted a method admitted by compatibility discovery.");
            cache.SetValue(null, commands);
            if (!ReferenceEquals(cache.GetValue(null), commands))
                throw new InvalidOperationException("Pipeline did not retain the validated command cache.");
        }
    }
}
