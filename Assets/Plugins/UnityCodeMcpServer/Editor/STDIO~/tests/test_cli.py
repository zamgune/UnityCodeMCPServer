"""Tests for the one-shot unity-code CLI."""

import json

import pytest

from unity_code_mcp_stdio import cli


class FakeClient:
    def __init__(self, response):
        self._response = response

    async def send_request(self, payload):
        self.last_payload = payload
        return self._response


def _patch_client(monkeypatch, response):
    client = FakeClient(response)
    monkeypatch.setattr(cli, "UnityFileClient", lambda **kwargs: client)
    return client


def _make_args(**overrides):
    import argparse

    defaults = {"project_root": None, "timeout": 5.0, "json": False}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


class TestParseCallArguments:
    def test_none_returns_empty_dict(self):
        assert cli._parse_call_arguments(None) == {}

    def test_json_object_is_parsed(self):
        assert cli._parse_call_arguments('{"a": 1}') == {"a": 1}

    def test_non_object_json_is_rejected(self):
        with pytest.raises(ValueError):
            cli._parse_call_arguments("[1, 2]")


class TestRunCall:
    def test_text_content_is_printed_and_exit_zero(self, monkeypatch, capsys):
        client = _patch_client(
            monkeypatch,
            {"result": {"content": [{"type": "text", "text": "hello"}]}},
        )

        exit_code = cli._run_call(_make_args(), "get_unity_info", {"a": 1})

        assert exit_code == 0
        assert capsys.readouterr().out == "hello\n"
        assert client.last_payload["params"] == {
            "name": "get_unity_info",
            "arguments": {"a": 1},
        }

    def test_tool_error_flag_maps_to_exit_one(self, monkeypatch):
        _patch_client(
            monkeypatch,
            {"result": {"isError": True, "content": [{"type": "text", "text": "boom"}]}},
        )

        assert cli._run_call(_make_args(), "t", {}) == cli.EXIT_TOOL_ERROR

    def test_transport_error_maps_to_exit_two(self, monkeypatch, capsys):
        _patch_client(monkeypatch, {"error": {"code": -32000, "message": "timed out"}})

        exit_code = cli._run_call(_make_args(), "t", {})

        assert exit_code == cli.EXIT_TRANSPORT_ERROR
        assert "timed out" in capsys.readouterr().err

    def test_json_flag_prints_raw_result(self, monkeypatch, capsys):
        result = {"content": [{"type": "text", "text": "hi"}], "isError": False}
        _patch_client(monkeypatch, {"result": result})

        exit_code = cli._run_call(_make_args(json=True), "t", {})

        assert exit_code == 0
        assert json.loads(capsys.readouterr().out) == result


class TestCmdList:
    def test_skips_markup_lines_in_description(self, monkeypatch, capsys):
        _patch_client(
            monkeypatch,
            {
                "result": {
                    "tools": [
                        {
                            "name": "exec",
                            "description": "<tool_description>\nRuns C#.\n</tool_description>",
                        }
                    ]
                }
            },
        )

        exit_code = cli._cmd_list(_make_args())

        assert exit_code == 0
        assert capsys.readouterr().out == "exec\tRuns C#.\n"
