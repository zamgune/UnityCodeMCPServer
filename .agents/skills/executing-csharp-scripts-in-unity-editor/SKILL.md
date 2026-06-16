---
name: executing-csharp-scripts-in-unity-editor
description: Use this skill always when you need to use execute_csharp_script_in_unity_editor tool to modify scenes, add, remove or modify game objects, components, scriptable objects or perform any other task in Unity Editor using C# scripts. Also covers when and how to use read_unity_console_logs and run_unity_tests tools as part of the same workflow  and create or modify favourite scripts used to automate tasks.
---

# Executing C# Scripts in Unity Editor

## Table of Contents

1. Available Tools
2. Core Principles
3. Forbidden Patterns
4. Usage Workflow
5. Debugging Loop
6. Compilation & Domain Reload Discipline
7. Favourite Scripts
8. Script Context and APIs
9. Common Scripting Patterns

---

## Available Tools

This skill coordinates three tools within one workflow. Use the tool that matches the task, and combine them when the task crosses from source edits to Editor automation or test verification.

| Tool                                    | Purpose                                                 | When to Use                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute_csharp_script_in_unity_editor` | Executes C# code in the live Unity Editor (Roslyn)      | Modifying scenes, GameObjects, Components, Prefabs, ScriptableObjects, or running Editor automation. Script output and logs are returned directly in the tool result.                              |
| `read_unity_console_logs`               | Reads recent entries from the Unity Editor Console      | Before executing an Editor script or Unity test when the task depends on compiled C# code. Also useful when debugging unexpected Editor state.                                                   |
| `run_unity_tests`                       | Runs EditMode or PlayMode Unity tests via TestRunnerApi | After editing C# source files to verify logic correctness. Do not use it for ad-hoc code execution, and do not run it solely because an Editor script was executed.                              |

---

## Core Principles

- **Top-Level Statements Only:** Write flat code. Do **not** wrap code in a class, method, or `[MenuItem]`. Provide only the sequence of statements and any required `using` directives.
- **Pre-Imported Namespaces:** `System`, `System.Collections.Generic`, `System.Linq`, `UnityEngine`, `UnityEditor` are always available. Do **not** redeclare them with `using`.
- **Explicit Usings for Others:** Declare any namespace not in the pre-imported list (e.g., `using UnityEngine.UI;`).
- **Idempotency:** Scripts must be safe to rerun. Check for existence before creating or adding to avoid duplicates. Use helper patterns like `GetOrAddComponent` and `CreateOrGetGameObject`.
- **Synchronous Only:** Do **not** use `async`/`await`, `Task`, or `Task.Run`. All Unity Editor APIs are main-thread-only and synchronous.
- **Null Checks:** Always use `== null` for Unity objects. Do **not** use `??` or `?.` — Unity objects override the `==` operator in ways that break null-conditional operators.
- **Specificity:** Prefer fully qualified names (e.g., `UnityEngine.GameObject`, `UnityEditor.AssetDatabase`) to avoid ambiguity.
- **Script Feedback:** Use `UnityEngine.Debug.Log()` to report what the script did. Use `UnityEngine.Debug.LogError()` for failures. The tool captures both.
- **Clarity & Error Handling:** Comment non-obvious logic. Wrap risky operations in `try-catch` and log errors with context.
- **Object class ambiguity:** Always use `UnityEngine.Object` when referring to Unity objects to avoid confusion with `System.Object`.

---

## Forbidden Patterns

**CRITICAL:** Never simulate an action or fabricate output if the API is unavailable.

- **Do NOT** log messages claiming to "simulate" or "pretend" a modification was made.
- **Do NOT** create placeholder logic that does nothing and logs fake success.
- **Do NOT** use `execute_csharp_script_in_unity_editor` to create or edit C# source files — use file editing tools instead.
- **Do NOT** use `execute_csharp_script_in_unity_editor` to read/write plain text, JSON, or YAML files — use file tools instead.
- **Do NOT** use `execute_csharp_script_in_unity_editor` to run tests — use `run_unity_tests` instead.
- **Do NOT** use background threads (`Thread`, `Task.Run`) — all Unity Editor APIs require the main thread.
- **Do NOT** use `async`/`await` inside scripts.

---

## Usage Workflow

Use the applicable steps in this order for each task. Skip only the steps that do not apply.

1. **Analyze Requirements:** Understand what needs to be created, modified, or queried. Identify target GameObjects, Components, assets, source files, and expected outcome.
2. **Check for Compilation Errors:** If the task depends on compiled C# code, call `read_unity_console_logs` (max_entries: 20) before executing any Editor script or Unity test. Prior C# file edits may have broken the build. Do not proceed until compilation errors are resolved.
3. **Analyze Unity Context:** When the task needs scene, prefab, or asset inspection, use `execute_csharp_script_in_unity_editor` to inspect hierarchy, existing components, and current asset state. Identify edge cases such as missing objects, duplicate components, or invalid asset paths.
4. **Plan the Action:** Determine which Unity APIs are needed and whether the task requires Editor scripting, source-file edits, Unity tests, or some combination of them.
5. **Write the Script or Source Change:** Apply all Core Principles. For Editor scripts, add idempotency guards, null checks, `Debug.Log` for significant actions, and `try-catch` for risky operations.
6. **Execute the Script:** When using Editor automation, call `execute_csharp_script_in_unity_editor`. All `Debug.Log` and `Debug.LogError` output is returned directly in the tool result — no separate log read is needed.
7. **Run Tests When Source Changed:** If you edited compiled C# source files, run the narrowest relevant Unity tests with `run_unity_tests` after the code compiles cleanly.
8. **Fix and Retry:** If script execution, compilation, or tests fail, apply the Debugging Loop before reporting completion.

---

## Debugging Loop

When a script execution returns errors or unexpected results:

1. Read the error message and stack trace returned directly in the tool result.
2. If the error suggests a compilation failure (e.g., type not found, missing member), call `read_unity_console_logs` (max_entries: 30) to identify the source C# file causing the build error, fix it, then re-execute.
3. Otherwise, identify the root cause from the script output: missing object, bad asset path, wrong API usage, or null reference.
4. Fix the script and re-execute.
5. Repeat until the tool result confirms success with no errors.

---

## Compilation & Domain Reload Discipline

Editing C# source files triggers a recompile and an AppDomain reload inside the Unity Editor. The MCP bridge handles this transparently, but it changes the **timing** of tool calls, and mishandling that timing is the single most common cause of spurious timeouts.

### What the bridge does during a reload

- A request that arrives while the editor is **compiling or reloading is not answered with an error.** The server leaves it pending on disk and answers it **after** the fresh assemblies finish loading.
- Therefore a single `execute_csharp_script_in_unity_editor`, `run_unity_tests`, or `read_unity_console_logs` call issued right after a source edit can legitimately block for the **entire compile + reload** — often tens of seconds, and minutes on a large project. **This is expected, not a hang.**
- The bridge is single-flight: it processes one request at a time and resumes pending requests after the reload. Firing duplicates does not make it faster — it only piles up work.

### Rules

1. **One call, then wait.** After editing C# source, issue **one** tool call and let it ride out the reload. Do **not** cancel and re-issue the same call because it "seems slow." Duplicate requests confuse the single-flight bridge and waste the timeout budget.
2. **The client tool-call timeout must exceed the reload time.** Most MCP clients abort a tool call after a per-call timeout (commonly **60s by default**), which is shorter than a full recompile. When that fires, the client gives up *before* Unity answers, even though the bridge would have waited. Raise the client's per-tool timeout to **at least the bridge's `--request-timeout`** (180s+). See _Client timeout configuration_ below.
3. **On a "compiling" or "compiler errors" result, do not spam-retry.** If a call returns `Cannot ... while the editor is compiling` or `Cannot ... while the project has compiler errors`, **stop.** Call `read_unity_console_logs` (max_entries: 30), fix the offending source file, and only then re-issue. Re-firing the same call against a red build returns the same error every time and burns the timeout budget.
4. **Verify in order:** console clean → `run_unity_tests` → (only if runtime behavior matters) play mode. Never run tests while the build is red.

### Client timeout configuration

Register the Unity MCP with a per-tool timeout **>= the bridge `--request-timeout`**, and a startup timeout large enough that Unity can be mid-reload when the bridge connects.

For Codex (`~/.codex/config.toml`, or the per-project Codex config where the Unity MCP is registered):

```toml
[mcp_servers.unity]
command = "uv"
args = [
  "run", "--directory",
  "<UnityProject>/Assets/Plugins/UnityCodeMcpServer/Editor/STDIO~",
  "unity-code-mcp-stdio", "--request-timeout", "240",
]
startup_timeout_sec = 60   # Unity may be compiling/reloading when the bridge connects
tool_timeout_sec = 300     # MUST be >= --request-timeout, or Codex aborts mid-reload (default 60s is too low)
```

The rule generalizes to any client: keep `client per-tool timeout >= bridge --request-timeout`.

---

## Favourite Scripts

Favourite Scripts are reusable C# scripts stored in `.unityCodeMcpServer/favouriteScripts.json` at the project root. They share the same execution engine as `execute_csharp_script_in_unity_editor` and are accessible from the Unity Editor at **Tools > UnityCodeMcpServer > Favourite Scripts**.

Use Favourite Scripts for any automation that is likely to be run again — bulk asset updates, scene wiring, import fixes, procedural placement. Once saved, the script is a one-click tool.

### File Location and Format

```
{project root}/.unityCodeMcpServer/favouriteScripts.json
```

```json
[
  {
    "name": "Script Name",
    "script": "// C# top-level statements — same rules as execute_csharp_script_in_unity_editor"
  }
]
```

### Saving a Favourite Script

When the user asks to save a script as a favourite, use file tools to read the current JSON, upsert the entry (match by `name`, case-insensitive), then write it back.

```
1. Read `.unityCodeMcpServer/favouriteScripts.json` (create as empty array `[]` if missing).
2. Find an existing entry whose `name` matches — replace it. Otherwise append.
3. Write the updated array back with indentation.
```

Always preserve all existing entries when writing back. Never overwrite the file with only the new entry.

### Updating and Deleting

- **Update:** same upsert flow — match by name, replace the `script` value.
- **Delete:** remove the matching entry and write the array back.

### Workflow

1. Write and refine the script using `execute_csharp_script_in_unity_editor` until the output is correct.
2. When the user is satisfied, save it as a favourite. The user can then run it any time from the Editor window without the agent.

---

## Script Context and APIs

### Pre-Imported Namespaces (do NOT add `using` for these)

- `System`
- `System.Collections.Generic`
- `System.Linq`
- `UnityEngine`
- `UnityEditor`

### Commonly Needed Explicit Usings

```csharp
using UnityEngine.UI;
using UnityEngine.SceneManagement;
using UnityEditor.SceneManagement;
using TMPro;
```

### Loaded Assemblies

Only loaded assemblies are available.

#### Assemblies included by default:

- System.Core,
- UnityEditor.CoreModule,
- UnityEngine.CoreModule,
- Assembly-CSharp,
- Assembly-CSharp-Editor

#### Loading Additional Assemblies:

Additional assemblies are defined in `AdditionalAssemblyNames` list in `Assets/Plugins/UnityCodeMcpServer/Editor/UnityCodeMcpServerSettings.asset`. Add any assembly name there (e.g., "MyCustomAssembly") and it will be loaded and available in the script context.

#### Forcing Settings Reload After File Edit:

After editing `UnityCodeMcpServerSettings.asset` directly via file tools, the new assemblies are **not** available until Unity reprocesses the asset. After the file edit, execute this script to force a reload before using the new assemblies:

```csharp
var settings = AssetDatabase.LoadAssetAtPath<ScriptableObject>("Assets/Plugins/UnityCodeMcpServer/Editor/UnityCodeMcpServerSettings.asset");
EditorUtility.SetDirty(settings);
AssetDatabase.SaveAssets();
AssetDatabase.ImportAsset("Assets/Plugins/UnityCodeMcpServer/Editor/UnityCodeMcpServerSettings.asset", ImportAssetOptions.ForceUpdate);
Debug.Log("Settings reloaded — new assemblies now available");
```

### Key API Reference

| Task                         | API                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Find active scene GameObject | `UnityEngine.GameObject.Find("Name")`                                                     |
| Find all objects of type     | `UnityEngine.Object.FindObjectsByType<T>(FindObjectsSortMode.None)`                       |
| Load asset from path         | `UnityEditor.AssetDatabase.LoadAssetAtPath<T>("Assets/...")`                              |
| Save all dirty assets        | `UnityEditor.AssetDatabase.SaveAssets()`                                                  |
| Refresh asset database       | `UnityEditor.AssetDatabase.Refresh()`                                                     |
| Mark object dirty            | `UnityEditor.EditorUtility.SetDirty(obj)`                                                 |
| Open scene                   | `UnityEditor.SceneManagement.EditorSceneManager.OpenScene("Assets/Scenes/MyScene.unity")` |
| Save open scene              | `UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes()`                         |

---

## Common Scripting Patterns

### Safe Get-or-Add Component

```csharp
T GetOrAddComponent<T>(UnityEngine.GameObject go) where T : UnityEngine.Component {
    var c = go.GetComponent<T>();
    if (c == null) c = go.AddComponent<T>();
    return c;
}
```

### Safe Create-or-Get GameObject

```csharp
UnityEngine.GameObject CreateOrGetGameObject(string name, UnityEngine.Transform parent = null) {
    var existing = UnityEngine.GameObject.Find(name);
    if (existing != null) return existing;
    var go = new UnityEngine.GameObject(name);
    if (parent != null) go.transform.SetParent(parent, false);
    return go;
}
```

### Creating and Parenting Objects

```csharp
var parent = UnityEngine.GameObject.Find("Canvas");
if (parent == null) { UnityEngine.Debug.LogError("Canvas not found"); return; }

var panel = CreateOrGetGameObject("HUD_Panel", parent.transform);
using UnityEngine.UI;
var image = GetOrAddComponent<Image>(panel);
image.color = new UnityEngine.Color(0f, 0f, 0f, 0.5f);
UnityEngine.Debug.Log("HUD_Panel configured");
```

### Modifying Prefab Assets

**CRITICAL:** Always use the Load → Modify → Save → Unload cycle. Never edit a prefab in-scene to affect the asset.

```csharp
string path = "Assets/Prefabs/MyPrefab.prefab";
var root = UnityEditor.PrefabUtility.LoadPrefabContents(path);
if (root == null) { UnityEngine.Debug.LogError("Prefab not found: " + path); return; }

try {
    var rb = GetOrAddComponent<UnityEngine.Rigidbody2D>(root);
    rb.gravityScale = 0f;
    UnityEditor.PrefabUtility.SaveAsPrefabAsset(root, path);
    UnityEngine.Debug.Log("Prefab saved: " + path);
} finally {
    UnityEditor.PrefabUtility.UnloadPrefabContents(root);
}
```

### Querying Scene State

```csharp
var allObjects = UnityEngine.Object.FindObjectsByType<UnityEngine.GameObject>(UnityEngine.FindObjectsSortMode.None);
foreach (var go in allObjects) {
    UnityEngine.Debug.Log($"{go.name} | Layer: {UnityEngine.LayerMask.LayerToName(go.layer)} | Active: {go.activeSelf}");
}
```

### Creating a ScriptableObject Asset

```csharp
var so = UnityEngine.ScriptableObject.CreateInstance<MyScriptableObjectType>();
so.someField = 42;
UnityEditor.AssetDatabase.CreateAsset(so, "Assets/Data/MyAsset.asset");
UnityEditor.AssetDatabase.SaveAssets();
UnityEngine.Debug.Log("ScriptableObject created at Assets/Data/MyAsset.asset");
```

### Deleting a GameObject

Store the name before destroying, since the object becomes invalid immediately after.

```csharp
var target = UnityEngine.GameObject.Find("ToDestroy");
if (target != null) {
    string name = target.name;
    UnityEngine.Object.DestroyImmediate(target);
    UnityEngine.Debug.Log("Destroyed: " + name);
} else {
    UnityEngine.Debug.Log("Object not found — nothing to destroy");
}
```

### Missing Namespace or Assembly Errors

When encountering errors about missing types or namespaces, like `error CS0234: The type or namespace name 'UI' does not exist in the namespace 'UnityEngine' (are you missing an assembly reference?)`:

1. Identify the required assembly and namespace for the API you are trying to use.
2. Check if that assembly is included in the loaded assemblies or `AdditionalAssemblyNames` in `UnityCodeMcpServerSettings.asset`.
3. If it is not, add it to `AdditionalAssemblyNames` in `UnityCodeMcpServerSettings.asset` via file tools.
4. **Force a settings reload** by executing the reload script from the _Forcing Settings Reload After File Edit_ section above. The new assembly will not be available until this is done.
5. Ensure you have the correct `using` directive for the namespace at the top of your script.
