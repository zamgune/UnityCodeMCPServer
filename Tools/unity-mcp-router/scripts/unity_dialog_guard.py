#!/usr/bin/env python3
"""Stop Unity calls that would open a modal dialog in the shared Editor.

A modal dialog blocks Unity's main thread. The call that opened it times out, the router
records UNKNOWN_OUTCOME and fences the project, and every session waits for a person to
click the dialog. Two known sources:

  * Running tests (test_run / run_tests, TestRunnerApi) or entering Play through the project's Boot
    launcher (PlayGame, PlaytestSessionCoordinator.Run, PlaytestSevenDayRun.Start) while an
    open scene has unsaved changes: Unity asks "Scene(s) Have Been Modified".
  * Code that shows a dialog itself (EditorUtility.DisplayDialog, ResetGameplaySaveData).

As a Claude Code PreToolUse hook (stdin = hook JSON) it denies such a call before it is sent:
dirty scenes are listed with the catalog's scene_list_open (or legacy list_open_scenes)
through the managed adapter. A call that only
might prompt is let through when no scene is dirty. When the check itself cannot run (Editor
unreachable), the call is let through with a note, so the guard never locks a session out.

  unity_dialog_guard.py                  hook mode (reads the hook JSON on stdin)
  unity_dialog_guard.py --check NAME     exit 0 clean, 2 dirty, 1 if the check could not run
  unity_dialog_guard.py --self-test
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
TOOL_PREFIX = "mcp__unity__"
TEST_TOOLS = {"run_tests", "test_run"}
SCRIPT_TOOLS = {"eval", "eval_file", "run_script", "script_eval", "script_run"}

# Code that always opens a modal dialog: never run it unattended.
ALWAYS_DIALOG = [
    (re.compile(r"\bDisplayDialog(Complex)?\s*\("), "EditorUtility.DisplayDialog"),
    (re.compile(r"\bResetGameplaySaveData\s*\("), "CustomGameLauncherActions.ResetGameplaySaveData (asks to confirm)"),
]

# Code that prompts to save when an open scene is dirty.
PROMPTS_WHEN_DIRTY = [
    (re.compile(r"\bPlayGame\s*\(|\bPlayBootstrap\s*\(|\bPlayIslandV2TestScene\s*\("), "the Boot launcher"),
    (re.compile(r"\bPlaytestSessionCoordinator\s*\.\s*(Run|Restart)\s*\("), "PlaytestSessionCoordinator"),
    (re.compile(r"\bPlaytestSevenDayRun\s*\.\s*Start\s*\("), "PlaytestSevenDayRun"),
    (re.compile(r"\bTestRunnerApi\b"), "the Unity Test Runner"),
    (re.compile(r"\bSave(Current)?ModifiedScenesIfUserWantsTo\s*\("), "SaveCurrentModifiedScenesIfUserWantsTo"),
]


# ---------------------------------------------------------------- decision (pure)

def classify(tool, code):
    """('dialog', why) | ('dirty-check', why) | ('skip', None) for one tool call."""
    if tool in TEST_TOOLS:
        return "dirty-check", tool
    if tool not in SCRIPT_TOOLS:
        return "skip", None
    if code is None:
        # File we could not read: we cannot rule anything out, so check the scenes.
        return "dirty-check", f"{tool} (source not readable)"
    for pattern, why in ALWAYS_DIALOG:
        if pattern.search(code):
            return "dialog", why
    for pattern, why in PROMPTS_WHEN_DIRTY:
        if pattern.search(code):
            return "dirty-check", why
    return "skip", None


def dirty_scenes(listing):
    # Pipeline 1.0 writes scene records as an array; older releases wrapped it.
    # Missing/malformed evidence must never turn into a successful clean check.
    scenes = listing.get("scenes") if isinstance(listing, dict) else listing
    if not isinstance(scenes, list):
        raise ValueError("scene list must be an array or an object containing scenes")
    dirty = []
    for scene in scenes:
        if not isinstance(scene, dict) or type(scene.get("isDirty")) is not bool:
            raise ValueError("scene record has no boolean isDirty")
        if scene["isDirty"]:
            label = scene.get("path") or scene.get("name") or "Untitled"
            if not isinstance(label, str):
                raise ValueError("scene label is not text")
            dirty.append(label)
    return dirty


def deny_reason_dialog(why):
    return (f"Blocked by the Unity dialog guard: this code calls {why}, which opens a modal dialog. "
            "In the shared Editor the dialog blocks Unity's main thread, the call times out and the "
            "router fences every session until a person clicks it. Do the step without the dialog "
            "(call the underlying API directly) or ask the user to do it in Unity.")


def deny_reason_dirty(why, scenes):
    return (f"Blocked by the Unity dialog guard: {why} would ask to save modified scenes "
            f"({', '.join(scenes)}), and that dialog blocks the shared Editor and fences every "
            "session. If the change is yours, save it first with the project's scene-save tool; if it is not, ask the user "
            "or the session that owns it. Do not save or discard another session's change.")


# ---------------------------------------------------------------- probes

def router_project_root(alias):
    try:
        with open(os.path.expanduser("~/.unity-mcp-router/current/config.json")) as f:
            projects = json.load(f).get("projects", [])
        matches = [p for p in projects if alias == p.get("name") or alias in p.get("aliases", [])]
        if len(matches) == 1 and os.path.isabs(matches[0].get("path", "")):
            return matches[0]["path"]
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return None


def project_alias(tool_input, cwd):
    """The router alias the call goes to: explicit `project`, else the session's adapter default."""
    if tool_input.get("project"):
        alias = tool_input["project"]
        return alias, router_project_root(alias)
    try:
        with open(os.path.expanduser("~/.claude.json")) as f:
            projects = json.load(f).get("projects") or {}
    except (OSError, ValueError):
        projects = {}
    path = os.path.abspath(cwd or os.getcwd())
    while True:
        server = ((projects.get(path) or {}).get("mcpServers") or {}).get("unity") or {}
        if not server:
            try:
                with open(os.path.join(path, ".mcp.json")) as f:
                    server = (json.load(f).get("mcpServers") or {}).get("unity") or {}
            except (OSError, ValueError):
                server = {}
        args = server.get("args") or []
        if "--default" in args and args.index("--default") + 1 < len(args):
            alias = args[args.index("--default") + 1]
            return alias, router_project_root(alias) or path
        parent = os.path.dirname(path)
        if parent == path:
            return None, None
        path = parent


def read_source(tool, tool_input, roots):
    if tool in ("eval", "script_eval") and not tool_input.get("file"):
        return tool_input.get("code") or ""
    path = tool_input.get("file") or ""
    # The first known project root is authoritative. A missing project file
    # must not fall back to a different same-named script in the agent's cwd.
    root = next((r for r in roots if r), None)
    candidates = [path] if os.path.isabs(path) else [os.path.join(root, path)] if root else []
    for candidate in candidates:
        try:
            with open(candidate, encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            continue
    return None


def managed_adapter(project):
    # Installed beside the existing managed-client helper. Offline tests and
    # --self-test need neither that helper nor a broker/Editor connection.
    from unity_fence_heal import Adapter
    return Adapter(project)


def result_payload(message):
    if not isinstance(message, dict) or message.get("error") is not None:
        raise ValueError("managed adapter did not return a successful response")
    result = message.get("result")
    if not isinstance(result, dict) or result.get("isError") is True:
        raise ValueError("managed adapter returned a tool error")
    return result


def scene_tool(adapter):
    names, cursors = set(), set()
    params = {}
    for _ in range(32):
        result = result_payload(adapter.request("tools/list", params, timeout=20))
        tools = result.get("tools")
        if not isinstance(tools, list):
            raise ValueError("tool catalog is not a list")
        for tool in tools:
            name = tool.get("name") if isinstance(tool, dict) else None
            if not isinstance(name, str) or not name or name in names:
                raise ValueError("tool catalog has invalid or duplicate names")
            names.add(name)
        cursor = result.get("nextCursor")
        if cursor is None:
            break
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError("tool catalog pagination is invalid")
        cursors.add(cursor)
        params = {"cursor": cursor}
    else:
        raise ValueError("tool catalog pagination exceeded its limit")
    for name in ("scene_list_open", "list_open_scenes"):
        if name in names:
            return name
    raise ValueError("tool catalog does not advertise an open-scene query")


def parse_scene_response(message):
    result = result_payload(message)
    candidates = []
    if "structuredContent" in result:
        candidates.append(result["structuredContent"])
    content = result.get("content", [])
    if not isinstance(content, list):
        raise ValueError("tool content is not a list")
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            candidates.append(json.loads(item["text"]))
    if not candidates:
        raise ValueError("scene query returned no scene data")
    listings = []
    for candidate in candidates:
        dirty_scenes(candidate)  # Validate every representation, including an empty array.
        listings.append(candidate["scenes"] if isinstance(candidate, dict) else candidate)
    if any(listing != listings[0] for listing in listings[1:]):
        raise ValueError("scene query returned conflicting representations")
    return listings[0]


def list_scenes(alias, attempts=2, adapter_factory=None):
    adapter_factory = adapter_factory or managed_adapter
    last = "no answer"
    for attempt in range(attempts):
        adapter = None
        try:
            adapter = adapter_factory({"name": alias})
            name = scene_tool(adapter)
            message = adapter.request("tools/call", {"name": name, "arguments": {}}, timeout=20)
            return parse_scene_response(message), None
        except (OSError, ValueError, RuntimeError) as error:
            last = str(error)
        finally:
            if adapter is not None:
                adapter.close()
        if attempt + 1 < attempts:
            time.sleep(3)
    return None, last


# ---------------------------------------------------------------- modes

def emit(decision=None, reason=None, note=None):
    output = {"hookSpecificOutput": {"hookEventName": "PreToolUse"}}
    if decision:
        output["hookSpecificOutput"]["permissionDecision"] = decision
        output["hookSpecificOutput"]["permissionDecisionReason"] = reason
    if note:
        output["hookSpecificOutput"]["additionalContext"] = note
        output["systemMessage"] = note
    print(json.dumps(output))


def hook():
    payload = json.load(sys.stdin)
    name = payload.get("tool_name") or ""
    if not name.startswith(TOOL_PREFIX):
        return 0
    tool = name[len(TOOL_PREFIX):]
    tool_input = payload.get("tool_input") or {}
    if tool not in TEST_TOOLS | SCRIPT_TOOLS:
        return 0
    alias, alias_root = project_alias(tool_input, payload.get("cwd"))
    roots = [alias_root] if tool in ("script_eval", "script_run") else [alias_root, payload.get("cwd")]
    code = None if tool in TEST_TOOLS else read_source(tool, tool_input, roots)
    kind, why = classify(tool, code)
    if kind == "skip":
        return 0
    if kind == "dialog":
        emit("deny", deny_reason_dialog(why))
        return 0
    if alias is None:
        emit(note=f"Unity dialog guard: could not tell which Unity project {name} targets, so dirty scenes were not checked.")
        return 0
    listing, error = list_scenes(alias)
    if listing is None:
        emit(note=f"Unity dialog guard: could not list {alias}'s open scenes ({error}); dirty scenes were not checked before {name}.")
        return 0
    scenes = dirty_scenes(listing)
    if scenes:
        emit("deny", deny_reason_dirty(why, scenes))
    return 0


def check(alias):
    listing, error = list_scenes(alias)
    if listing is None:
        print(f"could not list open scenes of {alias}: {error}", file=sys.stderr)
        return 1
    scenes = dirty_scenes(listing)
    print("dirty: " + ", ".join(scenes) if scenes else "no dirty scene")
    return 2 if scenes else 0


def self_test():
    cases = [
        (("run_tests", None), "dirty-check"),
        (("test_run", None), "dirty-check"),
        (("script_eval", "EditorUtility.DisplayDialog(\"a\", \"b\", \"ok\");"), "dialog"),
        (("script_run", "static void Main(){ PlayGame(); }"), "dirty-check"),
        (("eval", "return EditorApplication.isPlaying;"), "skip"),
        (("eval", "CustomGameLauncherActions.PlayGame(); return 1;"), "dirty-check"),
        (("eval", "PlaytestSessionCoordinator.Run(state);"), "dirty-check"),
        (("eval", "PlaytestSevenDayRun.Start(4f, false);"), "dirty-check"),
        (("eval", "PlaytestSevenDayRun.Status();"), "skip"),
        (("eval", "var api = ScriptableObject.CreateInstance<TestRunnerApi>();"), "dirty-check"),
        (("eval", "EditorUtility.DisplayDialog(\"a\", \"b\", \"ok\");"), "dialog"),
        (("eval", "EditorUtility.DisplayDialogComplex(\"a\", \"b\", \"x\", \"y\", \"z\");"), "dialog"),
        (("eval", "CustomGameLauncherActions.ResetGameplaySaveData();"), "dialog"),
        (("eval_file", None), "dirty-check"),
        (("run_script", "static void Main(){ PlayGame(); }"), "dirty-check"),
        (("editor_status", "PlayGame()"), "skip"),
    ]
    failed = 0
    for (tool, code), expected in cases:
        got = classify(tool, code)[0]
        ok = got == expected
        failed += 0 if ok else 1
        print(("ok   " if ok else "FAIL ") + f"{tool}: {(code or '')[:50]!r} -> {got}")
    listing = {"scenes": [{"path": "Assets/A.unity", "isDirty": True}, {"path": "Assets/B.unity", "isDirty": False},
                          {"name": "Untitled", "path": "", "isDirty": True}]}
    ok = dirty_scenes(listing) == dirty_scenes(listing["scenes"]) == ["Assets/A.unity", "Untitled"]
    failed += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + "dirty scene names")
    total = len(cases) + 1
    print(f"{total - failed}/{total} passed")
    return 1 if failed else 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv == ["--self-test"]:
            return self_test()
        if len(argv) == 2 and argv[0] == "--check":
            return check(argv[1])
        if argv:
            raise ValueError("usage: unity_dialog_guard.py [--check NAME | --self-test]")
        return hook()
    except Exception as error:
        if argv:
            print(f"Unity dialog guard could not complete its check: {error}", file=sys.stderr)
            return 1
        # Keep the existing hook fail-open policy, with an explicit unchecked note.
        emit(note=f"Unity dialog guard failed and did not check this call: {error}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
