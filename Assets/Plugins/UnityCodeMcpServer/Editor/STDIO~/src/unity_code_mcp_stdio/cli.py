"""One-shot CLI for the Unity Code MCP file bridge.

Lets any shell-capable agent call Unity tools directly, without MCP
registration and without MCP per-tool timeouts:

    unity-code list
    unity-code call read_unity_console_logs '{"max_entries": 50}'
    unity-code exec 'return Application.unityVersion;'
    echo 'Debug.Log("hi"); return null;' | unity-code exec
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from unity_code_mcp_stdio.unity_code_mcp_stdio import (
    DEFAULT_FILE_REQUEST_TIMEOUT,
    UnityFileClient,
    get_project_root,
)

# The bridge module silences stderr at import time to protect JSON-RPC stdio;
# a CLI must report errors, so restore it.
sys.stderr = sys.__stderr__

EXIT_TOOL_ERROR = 1
EXIT_TRANSPORT_ERROR = 2


def _fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return EXIT_TRANSPORT_ERROR


def _send(args: argparse.Namespace, payload: dict[str, Any]) -> dict[str, Any]:
    client = UnityFileClient(
        project_root=args.project_root or get_project_root(),
        request_timeout=args.timeout,
    )
    return asyncio.run(client.send_request(payload))


def _save_image(item: dict[str, Any]) -> Path:
    extension = (item.get("mimeType") or "image/png").rsplit("/", 1)[-1]
    path = Path.cwd() / (
        f"unity-code-{datetime.now().strftime('%Y%m%d-%H%M%S%f')[:-3]}.{extension}"
    )
    path.write_bytes(base64.b64decode(item.get("data", "")))
    return path


def _print_content(result: dict[str, Any]) -> None:
    for item in result.get("content", []):
        item_type = item.get("type")
        if item_type == "text":
            print(item.get("text", ""))
        elif item_type == "image":
            print(f"[image saved to {_save_image(item)}]")
        else:
            print(json.dumps(item, ensure_ascii=False))


def _run_call(args: argparse.Namespace, name: str, arguments: dict[str, Any]) -> int:
    response = _send(
        args,
        {
            "jsonrpc": "2.0",
            "id": f"cli_call_{name}",
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    if "error" in response:
        return _fail(response["error"].get("message", "unknown error"))

    result = response.get("result", {})
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        _print_content(result)
    return EXIT_TOOL_ERROR if result.get("isError") else 0


def _parse_call_arguments(raw: str | None) -> dict[str, Any]:
    if raw is None:
        return {}
    text = sys.stdin.read() if raw == "-" else raw
    if not text.strip():
        return {}
    arguments = json.loads(text)
    if not isinstance(arguments, dict):
        raise ValueError("tool arguments must be a JSON object")
    return arguments


def _cmd_list(args: argparse.Namespace) -> int:
    response = _send(
        args,
        {"jsonrpc": "2.0", "id": "cli_list_tools", "method": "tools/list", "params": {}},
    )
    if "error" in response:
        return _fail(response["error"].get("message", "unknown error"))

    tools = response.get("result", {}).get("tools", [])
    if args.json:
        print(json.dumps(tools, ensure_ascii=False))
        return 0
    for tool in tools:
        lines = (tool.get("description") or "").strip().split("\n")
        # Some descriptions open with XML-ish markup tags; skip to prose.
        description = next(
            (ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("<")),
            "",
        )
        print(f"{tool.get('name')}\t{description}")
    return 0


def _cmd_call(args: argparse.Namespace) -> int:
    try:
        arguments = _parse_call_arguments(args.arguments)
    except (json.JSONDecodeError, ValueError) as exc:
        return _fail(f"invalid tool arguments: {exc}")
    return _run_call(args, args.tool, arguments)


def _cmd_exec(args: argparse.Namespace) -> int:
    script = sys.stdin.read() if args.code is None else args.code
    if not script.strip():
        return _fail("no C# code provided (pass as argument or via stdin)")
    return _run_call(
        args, "execute_csharp_script_in_unity_editor", {"script": script}
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="unity-code",
        description="One-shot CLI for the Unity Code MCP file bridge",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        help="Unity project root (directory containing Assets/). Defaults to the"
        " project this bridge copy lives in.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_FILE_REQUEST_TIMEOUT,
        help="Seconds to wait for the Unity response (domain reloads can take"
        " the full duration)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the raw JSON result instead of rendered text",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="List available Unity tools")

    call_parser = subparsers.add_parser("call", help="Call a Unity tool by name")
    call_parser.add_argument("tool", help="Tool name (see `unity-code list`)")
    call_parser.add_argument(
        "arguments",
        nargs="?",
        default=None,
        help="Tool arguments as a JSON object, or `-` to read JSON from stdin",
    )

    exec_parser = subparsers.add_parser(
        "exec", help="Execute C# code in the Unity Editor"
    )
    exec_parser.add_argument(
        "code",
        nargs="?",
        default=None,
        help="C# code (use `return ...;` for a value); omit to read from stdin",
    )

    args = parser.parse_args()
    handlers = {"list": _cmd_list, "call": _cmd_call, "exec": _cmd_exec}
    sys.exit(handlers[args.command](args))


if __name__ == "__main__":
    main()
