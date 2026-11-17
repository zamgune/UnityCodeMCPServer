import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "unity_dialog_guard.py"
spec = importlib.util.spec_from_file_location("guard", SOURCE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def reply(value):
    return {"result": {"content": [{"type": "text", "text": json.dumps(value)}]}}


class FakeAdapter:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.closed = False

    def request(self, method, params, timeout):
        self.calls.append((method, params))
        return self.replies.pop(0)

    def close(self):
        self.closed = True


class GuardTests(unittest.TestCase):
    def test_modern_and_legacy_commands(self):
        for tool in guard.TEST_TOOLS:
            self.assertEqual(guard.classify(tool, None)[0], "dirty-check")
        for tool in guard.SCRIPT_TOOLS:
            self.assertEqual(guard.classify(tool, "EditorUtility.DisplayDialog(1);")[0], "dialog")
            self.assertEqual(guard.classify(tool, "PlayGame();")[0], "dirty-check")
            self.assertEqual(guard.classify(tool, "return 1;")[0], "skip")
            self.assertEqual(guard.classify(tool, None)[0], "dirty-check")
        self.assertEqual(guard.classify("global_test_run", None)[0], "skip")

    def test_raw_array_and_legacy_wrapper(self):
        scenes = [{"path": "Assets/A.unity", "isDirty": True}, {"isDirty": False}, {"isDirty": True}]
        for listing in [scenes, {"scenes": scenes}]:
            self.assertEqual(guard.dirty_scenes(listing), ["Assets/A.unity", "Untitled"])
            self.assertEqual(guard.parse_scene_response(reply(listing)), scenes)
        self.assertEqual(guard.dirty_scenes([]), [])

    def test_bad_or_conflicting_data_never_means_clean(self):
        for listing in [None, {}, {"scenes": None}, "[]", [None], [{}], [{"isDirty": "false"}]]:
            with self.subTest(listing=listing), self.assertRaises(ValueError):
                guard.parse_scene_response(reply(listing))
        for message in [None, {"error": {}}, {"result": {"isError": True}}, {"result": {}},
                        {"result": {"content": [{"type": "text", "text": "broken"}]}},
                        {"result": {"structuredContent": [], "content": reply([{"isDirty": True}])["result"]["content"]}}]:
            with self.subTest(message=message), self.assertRaises(ValueError):
                guard.parse_scene_response(message)

    def test_structured_content_and_matching_text(self):
        message = reply([])
        message["result"]["structuredContent"] = []
        self.assertEqual(guard.parse_scene_response(message), [])
        self.assertEqual(guard.parse_scene_response({"result": {"structuredContent": {"scenes": []}}}), [])

    def test_catalog_selection_and_pagination(self):
        adapter = FakeAdapter([
            {"result": {"tools": [{"name": "list_open_scenes"}], "nextCursor": "p2"}},
            {"result": {"tools": [{"name": "scene_list_open"}]}}, reply([])])
        self.assertEqual(guard.list_scenes("A", attempts=1, adapter_factory=lambda _: adapter), ([], None))
        self.assertEqual(adapter.calls, [("tools/list", {}), ("tools/list", {"cursor": "p2"}),
                                        ("tools/call", {"name": "scene_list_open", "arguments": {}})])
        self.assertTrue(adapter.closed)

    def test_legacy_catalog_and_failed_modern_call(self):
        for tool in ["list_open_scenes", "scene_list_open"]:
            adapter = FakeAdapter([{"result": {"tools": [{"name": tool}]}}, reply({"scenes": []})])
            self.assertEqual(guard.list_scenes("A", attempts=1, adapter_factory=lambda _: adapter), ([], None))
            self.assertEqual(adapter.calls[-1][1]["name"], tool)
        adapter = FakeAdapter([{"result": {"tools": [{"name": "scene_list_open"}, {"name": "list_open_scenes"}]}},
                               {"result": {"isError": True}}])
        listing, error = guard.list_scenes("A", attempts=1, adapter_factory=lambda _: adapter)
        self.assertIsNone(listing)
        self.assertTrue(error)
        self.assertEqual(len(adapter.calls), 2)  # No guessed legacy call after an error.
        self.assertTrue(adapter.closed)

    def test_bad_catalog_never_dispatches_a_scene_call(self):
        for catalog in [{}, {"tools": []}, {"tools": [{}]}, {"tools": [{"name": "x"}, {"name": "x"}]},
                        {"tools": [{"name": "scene_list_open"}], "nextCursor": 3}]:
            adapter = FakeAdapter([{"result": catalog}])
            listing, error = guard.list_scenes("A", attempts=1, adapter_factory=lambda _: adapter)
            self.assertIsNone(listing)
            self.assertTrue(error)
            self.assertEqual(len(adapter.calls), 1)
            self.assertTrue(adapter.closed)

    def test_script_eval_reads_inline_or_file(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "call.cs").write_text("PlayGame();")
            self.assertEqual(guard.read_source("script_eval", {"code": "return 1;"}, []), "return 1;")
            for tool in ["script_eval", "script_run"]:
                self.assertEqual(guard.read_source(tool, {"file": "call.cs"}, [directory]), "PlayGame();")
                self.assertIsNone(guard.read_source(tool, {"file": "missing.cs"}, [directory]))

    def test_relative_file_does_not_fall_back_to_another_project(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as cwd:
            Path(cwd, "call.cs").write_text("return 1;")
            self.assertIsNone(guard.read_source("script_run", {"file": "call.cs"}, [root, cwd]))
            self.assertIsNone(guard.read_source("script_eval", {"file": "call.cs"}, [None]))

    def test_standalone_exit_codes_and_exception(self):
        for result, expected in [(([], None), 0), (([{"isDirty": True}], None), 2), ((None, "offline"), 1)]:
            with patch.object(guard, "list_scenes", return_value=result), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(guard.main(["--check", "A"]), expected)
        with patch.object(guard, "list_scenes", side_effect=RuntimeError("offline")), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(guard.main(["--check", "A"]), 1)

    def test_hook_denies_dirty_modern_test_and_reports_unchecked_errors(self):
        for result, decision in [(([{"path": "A.unity", "isDirty": True}], None), "deny"),
                                 ((None, "offline"), None)]:
            payload = {"tool_name": "mcp__unity__test_run", "tool_input": {"project": "A", "async-tests": True}}
            output = io.StringIO()
            with patch.object(guard, "list_scenes", return_value=result), patch.object(guard.sys, "stdin", io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(output):
                self.assertEqual(guard.main([]), 0)
            message = json.loads(output.getvalue())["hookSpecificOutput"]
            self.assertEqual(message.get("permissionDecision"), decision)
            if decision is None:
                self.assertIn("not checked", message["additionalContext"])


if __name__ == "__main__":
    unittest.main()
