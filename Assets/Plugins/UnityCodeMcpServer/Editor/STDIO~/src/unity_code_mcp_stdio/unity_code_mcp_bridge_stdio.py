"""
Unity Code MCP STDIO Bridge.

Bridges MCP protocol over STDIO to Unity's Streamable HTTP endpoint.
Each Unity interaction is sent as a fresh HTTP POST to Unity's loopback-only
HTTP endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import time
from typing import Any, Protocol
from urllib import error, request

import anyio
from anyio import create_memory_object_stream, create_task_group
from mcp import types
from mcp.server import Server
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage
from pydantic import AnyUrl

# Configure logging to file only (STDIO protocol uses stdout for messages)
# Redirect stderr to devnull to prevent any output that could corrupt JSON-RPC.
sys.stderr = open(os.devnull, "w")

script_dir = os.path.dirname(os.path.abspath(__file__))
log_file_path = os.path.join(script_dir, "unity_code_mcp_bridge.log")

logger = logging.getLogger("unity-code-mcp-stdio")
logger.setLevel(logging.INFO)
logger.propagate = False

LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3
LOG_VALUE_PREVIEW_LIMIT = 160
DEFAULT_REQUEST_TIMEOUT = 120.0
REQUEST_UNAVAILABLE_ERROR_CODE = -32000
RETRY_GUIDANCE = (
    "Safe next step: wait for Unity to finish domain reload or script compilation, "
    "then retry the same MCP request."
)

formatter = logging.Formatter(
    "%(asctime)s - pid=%(process)d - %(levelname)s - %(message)s"
)

_REQUEST_TRACE_SEQUENCE = itertools.count(1)

DEFAULT_HTTP_PORT: int = 3001
HTTP_PROTOCOL_VERSION = "2025-03-26"
UNITY_HTTP_HOST: str = "127.0.0.1"

# Backward-compatible aliases for callers that still reference the legacy names.
DEFAULT_PORT = DEFAULT_HTTP_PORT
UNITY_HOST = UNITY_HTTP_HOST


class FlushingHandler(RotatingFileHandler):
    """File handler that flushes immediately after each log message."""

    def emit(self, record):
        super().emit(record)
        self.flush()


def _truncate_for_log(value: Any, limit: int = LOG_VALUE_PREVIEW_LIMIT) -> str:
    """Render a compact log-safe preview for structured values."""
    text = str(value).replace("\n", "\\n")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def _build_rotating_handler(log_path: str | Path) -> FlushingHandler:
    """Create the bridge log handler with explicit retention settings."""
    handler = FlushingHandler(
        str(log_path),
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(formatter)
    return handler


def _configure_logger() -> None:
    """Attach a single rotating file handler to the bridge logger."""
    if logger.handlers:
        return
    logger.addHandler(_build_rotating_handler(log_file_path))


def _describe_request(request_payload: dict[str, Any]) -> str:
    """Summarize a JSON-RPC request for diagnostic logging."""
    params = request_payload.get("params")
    fragments = [
        f"id={request_payload.get('id', 'unknown')}",
        f"method={request_payload.get('method', 'unknown')}",
    ]

    if isinstance(params, dict):
        if "name" in params:
            fragments.append(f"tool={params['name']}")
        if "uri" in params:
            fragments.append(f"uri={_truncate_for_log(params['uri'])}")
        arguments = params.get("arguments")
        if isinstance(arguments, dict):
            argument_keys = ",".join(sorted(arguments.keys())) or "<none>"
            fragments.append(f"argument_keys={argument_keys}")
        else:
            param_keys = ",".join(sorted(params.keys()))
            if param_keys:
                fragments.append(f"param_keys={param_keys}")

    return " ".join(fragments)


def _describe_response(response: dict[str, Any]) -> str:
    """Summarize a JSON-RPC response for diagnostic logging."""
    fragments = [f"id={response.get('id', 'unknown')}"]

    error_payload = response.get("error")
    if isinstance(error_payload, dict):
        fragments.append(f"error_code={error_payload.get('code', 'unknown')}")
        fragments.append(
            "error_message="
            + _truncate_for_log(error_payload.get("message", "Unknown error"))
        )
        return " ".join(fragments)

    result = response.get("result")
    if isinstance(result, dict):
        result_keys = ",".join(sorted(result.keys())) or "<none>"
        fragments.append(f"result_keys={result_keys}")
        for key in ("tools", "prompts", "resources", "content", "messages", "contents"):
            value = result.get(key)
            if isinstance(value, list):
                fragments.append(f"{key}_count={len(value)}")

    return " ".join(fragments)


def _next_request_trace_id() -> str:
    """Return a monotonic bridge-local trace id for correlating log lines."""
    return f"bridge-{next(_REQUEST_TRACE_SEQUENCE):06d}"


_configure_logger()


# ---------------------------------------------------------------------------
# Settings discovery
# ---------------------------------------------------------------------------

# Fixed path to the settings asset: this script lives at
#   <project>/Assets/Plugins/UnityCodeMcpServer/Editor/STDIO~/src/unity_code_mcp_stdio/
# The settings asset is always at
#   <project>/Assets/Plugins/UnityCodeMcpServer/Editor/UnityCodeMcpServerSettings.asset
# which is exactly 4 parent directories up from this file.
_SETTINGS_FILE: Path = (
    Path(__file__).parent.parent.parent.parent / "UnityCodeMcpServerSettings.asset"
)
"""Absolute path to the Unity settings asset derived from this module's location."""


def read_http_port_from_settings(settings_file: Path) -> int | None:
    """Parse the HTTP port from the Unity settings asset."""
    try:
        content = settings_file.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Could not read settings file '%s': %s", settings_file, exc)
        return None

    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("HttpPort:"):
            _, _, raw = stripped.partition(":")
            try:
                return int(raw.strip())
            except ValueError:
                logger.warning("Invalid HTTP port value in settings: '%s'", stripped)
                return None

    logger.warning("'HttpPort' key not found in settings file: %s", settings_file)
    return None


def get_http_port(_settings_file: Path | None = None) -> int:
    """Resolve the HTTP port from Unity project settings."""
    settings_file = _SETTINGS_FILE if _settings_file is None else _settings_file
    if not settings_file.is_file():
        logger.info(
            "Settings file not found at '%s'. Using default HTTP port %s.",
            settings_file,
            DEFAULT_HTTP_PORT,
        )
        return DEFAULT_HTTP_PORT

    port = read_http_port_from_settings(settings_file)
    if port is None:
        logger.info(
            "Could not read HTTP port from '%s'. Using default HTTP port %s.",
            settings_file,
            DEFAULT_HTTP_PORT,
        )
        return DEFAULT_HTTP_PORT

    logger.debug("Using HTTP port %s from '%s'.", port, settings_file)
    return port


# Backward-compatible function aliases for the old TCP-oriented module surface.
read_port_from_settings = read_http_port_from_settings
get_stdio_port = get_http_port


class UnityHttpClient:
    """Stateless HTTP client for the Unity MCP endpoint."""

    def __init__(
        self,
        host: str,
        port: int,
        retry_time: float,
        retry_count: int,
        port_resolver: Any = None,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ):
        self.host = host
        self.port = port
        self.retry_time = retry_time
        self.retry_count = retry_count
        self._port_resolver = port_resolver
        self.request_timeout = request_timeout
        self._lock = asyncio.Lock()

    @staticmethod
    def _remaining_time(deadline: float) -> float:
        return max(0.0, deadline - time.perf_counter())

    @staticmethod
    def _build_error(
        request_payload: dict[str, Any], code: int, message: str
    ) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": request_payload.get("id"),
            "error": {"code": code, "message": message},
        }

    @staticmethod
    def _build_retryable_error_message(last_failure: str) -> str:
        return (
            "Unity was unavailable long enough that the bridge stopped retrying. "
            f"Last observed failure: {last_failure}. {RETRY_GUIDANCE}"
        )

    def _endpoint_url(self) -> str:
        return f"http://{self.host}:{self.port}/mcp/"

    def _build_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": HTTP_PROTOCOL_VERSION,
        }

    async def disconnect(self, reason: str = "manual") -> None:
        logger.info("HTTP bridge reset reason=%s", reason)

    async def _refresh_port(self, trace_id: str, request_summary: str) -> None:
        if self._port_resolver is None:
            return

        current_port = self._port_resolver()
        if current_port == self.port:
            return

        logger.info(
            "trace=%s %s HTTP port changed from %s to %s",
            trace_id,
            request_summary,
            self.port,
            current_port,
        )
        self.port = current_port

    async def _sleep_before_retry(
        self,
        *,
        trace_id: str,
        request_summary: str,
        attempt: int,
        reason: str,
    ) -> None:
        if self.retry_time <= 0:
            return

        logger.info(
            "trace=%s retrying Unity HTTP request attempt=%s reason=%s sleep_s=%.3f %s",
            trace_id,
            attempt,
            reason,
            self.retry_time,
            request_summary,
        )
        await asyncio.sleep(self.retry_time)

    @staticmethod
    def _parse_sse_response(body: bytes) -> dict[str, Any] | None:
        event_name = "message"
        data_lines: list[str] = []

        for raw_line in body.decode("utf-8").splitlines():
            if not raw_line:
                if data_lines and event_name == "message":
                    return json.loads("\n".join(data_lines))
                event_name = "message"
                data_lines = []
                continue

            if raw_line.startswith(":"):
                continue

            field, _, value = raw_line.partition(":")
            value = value.lstrip(" ")
            if field == "event":
                event_name = value or "message"
            elif field == "data":
                data_lines.append(value)

        if data_lines and event_name == "message":
            return json.loads("\n".join(data_lines))

        return None

    async def _send_transport_request(
        self,
        request_payload: dict[str, Any],
        *,
        trace_id: str,
        request_summary: str,
        timeout_seconds: float,
    ) -> dict[str, Any] | None:
        if timeout_seconds <= 0:
            raise TimeoutError("request-timeout-exceeded")

        body = json.dumps(request_payload).encode("utf-8")
        headers = self._build_headers()

        def do_request() -> tuple[int, str, bytes]:
            http_request = request.Request(
                self._endpoint_url(),
                data=body,
                headers=headers,
                method="POST",
            )
            try:
                with request.urlopen(
                    http_request, timeout=timeout_seconds
                ) as http_response:
                    return (
                        http_response.status,
                        http_response.headers.get("Content-Type", ""),
                        http_response.read(),
                    )
            except error.HTTPError as exc:
                response_body = exc.read()
                content_type = exc.headers.get("Content-Type", "")
                if response_body and content_type.startswith("application/json"):
                    parsed = json.loads(response_body.decode("utf-8"))
                    return exc.code, content_type, json.dumps(parsed).encode("utf-8")
                raise

        status_code, content_type, response_body = await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
            do_request
        )

        logger.debug(
            "trace=%s Unity HTTP response status=%s content_type=%s bytes=%s %s",
            trace_id,
            status_code,
            content_type,
            len(response_body),
            request_summary,
        )

        if status_code == 202:
            return None

        if not response_body:
            raise RuntimeError(
                f"Unity HTTP response had no body (status {status_code})"
            )

        if content_type.startswith("application/json"):
            return json.loads(response_body.decode("utf-8"))

        if content_type.startswith("text/event-stream"):
            parsed = self._parse_sse_response(response_body)
            if parsed is None:
                raise RuntimeError("Unity SSE response did not contain an MCP message")
            return parsed

        raise RuntimeError(
            f"Unsupported Unity HTTP content type '{content_type or '<none>'}'"
        )

    async def send_request(self, request_payload: dict[str, Any]) -> dict[str, Any]:
        trace_id = _next_request_trace_id()
        request_summary = _describe_request(request_payload)
        started_at = time.perf_counter()

        logger.info(
            "trace=%s Unity HTTP request started %s endpoint=%s",
            trace_id,
            request_summary,
            self._endpoint_url(),
        )

        async with self._lock:
            last_failure = (
                "Unity HTTP endpoint did not become ready before the retry window expired"
            )
            attempt = 0

            while attempt < self.retry_count:
                try:
                    await self._refresh_port(trace_id, request_summary)

                    response = await self._send_transport_request(
                        request_payload,
                        trace_id=trace_id,
                        request_summary=request_summary,
                        timeout_seconds=self.request_timeout,
                    )
                    if response is None:
                        response = {
                            "jsonrpc": "2.0",
                            "id": request_payload.get("id"),
                            "result": {},
                        }

                    duration_ms = round((time.perf_counter() - started_at) * 1000)
                    logger.info(
                        "trace=%s Unity HTTP request completed %s duration_ms=%s response=%s",
                        trace_id,
                        request_summary,
                        duration_ms,
                        _describe_response(response),
                    )
                    return response
                except (
                    ConnectionError,
                    ConnectionRefusedError,
                    TimeoutError,
                    error.URLError,
                    OSError,
                ) as exc:
                    attempt += 1
                    last_failure = str(exc)
                    logger.warning(
                        "trace=%s Unity HTTP request transport error %s attempt=%s/%s error_type=%s error=%s",
                        trace_id,
                        request_summary,
                        attempt,
                        self.retry_count,
                        type(exc).__name__,
                        exc,
                    )
                    if attempt >= self.retry_count:
                        break
                    await self._sleep_before_retry(
                        trace_id=trace_id,
                        request_summary=request_summary,
                        attempt=attempt,
                        reason="transport-retry",
                    )
                except Exception as exc:
                    logger.error(
                        "trace=%s Unity HTTP request failed unexpectedly %s",
                        trace_id,
                        request_summary,
                        exc_info=True,
                    )
                    return self._build_error(
                        request_payload, -32603, f"Internal error: {exc}"
                    )

            duration_ms = round((time.perf_counter() - started_at) * 1000)
            logger.warning(
                "trace=%s Unity HTTP request exhausted retries %s duration_ms=%s last_failure=%s",
                trace_id,
                request_summary,
                duration_ms,
                last_failure,
            )
            return self._build_error(
                request_payload,
                REQUEST_UNAVAILABLE_ERROR_CODE,
                self._build_retryable_error_message(last_failure),
            )


UnityTcpClient = UnityHttpClient


class SafeServer(Server):
    """Server variant that treats closed client streams as expected teardown."""

    async def _handle_request(
        self,
        message,
        req,
        session,
        lifespan_context,
        raise_exceptions,
    ):
        try:
            await super()._handle_request(
                message,
                req,
                session,
                lifespan_context,
                raise_exceptions,
            )
        except anyio.ClosedResourceError:
            logger.info(
                "Client stream closed before response could be sent for request %s",
                getattr(message, "request_id", "unknown"),
            )


class UnityBridgeClient(Protocol):
    """Minimal client interface shared by the bridge transport."""

    async def send_request(self, request_payload: dict[str, Any]) -> dict[str, Any]: ...


def _convert_resource_contents(
    resource: dict[str, Any],
) -> types.TextResourceContents:
    """Convert Unity resource payload to an MCP TextResourceContents object."""
    return types.TextResourceContents(
        uri=resource.get("uri", ""),
        mimeType=resource.get("mimeType"),
        text=resource.get("text", ""),
    )


def _convert_content_item(
    item: dict[str, Any],
) -> types.TextContent | types.ImageContent | types.EmbeddedResource | None:
    """Convert a Unity content item to an MCP SDK content item."""
    item_type = item.get("type")
    if item_type == "text":
        return types.TextContent(type="text", text=item.get("text", ""))

    if item_type == "image":
        return types.ImageContent(
            type="image",
            data=item.get("data", ""),
            mimeType=item.get("mimeType", "image/png"),
        )

    if item_type == "resource":
        resource = item.get("resource", {})
        return types.EmbeddedResource(
            type="resource",
            resource=_convert_resource_contents(resource),
        )

    return None


def create_server(unity_client: UnityBridgeClient) -> Server:
    """Create MCP server that proxies requests to Unity."""
    server = SafeServer("unity-code-mcp-stdio")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        response = await unity_client.send_request(
            {
                "jsonrpc": "2.0",
                "id": "list_tools",
                "method": "tools/list",
                "params": {},
            }
        )

        if "error" in response:
            logger.error("Error listing tools: %s", response["error"])
            return []

        result = response.get("result", {})
        tools = result.get("tools", [])
        return [
            types.Tool(
                name=tool["name"],
                description=tool.get("description", ""),
                inputSchema=tool.get("inputSchema", {"type": "object"}),
            )
            for tool in tools
        ]

    @server.call_tool()
    async def call_tool(
        name: str, arguments: dict[str, Any]
    ) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
        response = await unity_client.send_request(
            {
                "jsonrpc": "2.0",
                "id": f"call_tool_{name}",
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )

        if "error" in response:
            error_payload = response["error"]
            return [
                types.TextContent(
                    type="text",
                    text=f"Error: {error_payload.get('message', 'Unknown error')}",
                )
            ]

        result = response.get("result", {})
        content = result.get("content", [])
        mcp_content: list[
            types.TextContent | types.ImageContent | types.EmbeddedResource
        ] = []
        for item in content:
            converted = _convert_content_item(item)
            if converted is not None:
                mcp_content.append(converted)

        return (
            mcp_content
            if mcp_content
            else [types.TextContent(type="text", text="No content returned")]
        )

    @server.list_prompts()
    async def list_prompts() -> list[types.Prompt]:
        response = await unity_client.send_request(
            {
                "jsonrpc": "2.0",
                "id": "list_prompts",
                "method": "prompts/list",
                "params": {},
            }
        )

        if "error" in response:
            logger.error("Error listing prompts: %s", response["error"])
            return []

        result = response.get("result", {})
        prompts = result.get("prompts", [])
        return [
            types.Prompt(
                name=prompt["name"],
                description=prompt.get("description"),
                arguments=[
                    types.PromptArgument(
                        name=arg["name"],
                        description=arg.get("description"),
                        required=arg.get("required", False),
                    )
                    for arg in prompt.get("arguments", [])
                ],
            )
            for prompt in prompts
        ]

    @server.get_prompt()
    async def get_prompt(
        name: str, arguments: dict[str, str] | None = None
    ) -> types.GetPromptResult:
        response = await unity_client.send_request(
            {
                "jsonrpc": "2.0",
                "id": f"get_prompt_{name}",
                "method": "prompts/get",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )

        if "error" in response:
            error_payload = response["error"]
            return types.GetPromptResult(
                description=f"Error: {error_payload.get('message', 'Unknown error')}",
                messages=[],
            )

        result = response.get("result", {})
        messages = result.get("messages", [])
        return types.GetPromptResult(
            description=result.get("description"),
            messages=[
                types.PromptMessage(
                    role=message["role"],
                    content=types.TextContent(
                        type="text",
                        text=message.get("content", {}).get("text", ""),
                    ),
                )
                for message in messages
            ],
        )

    @server.list_resources()
    async def list_resources() -> list[types.Resource]:
        response = await unity_client.send_request(
            {
                "jsonrpc": "2.0",
                "id": "list_resources",
                "method": "resources/list",
                "params": {},
            }
        )

        if "error" in response:
            logger.error("Error listing resources: %s", response["error"])
            return []

        result = response.get("result", {})
        resources = result.get("resources", [])
        return [
            types.Resource(
                uri=resource["uri"],
                name=resource.get("name", ""),
                description=resource.get("description"),
                mimeType=resource.get("mimeType"),
            )
            for resource in resources
        ]

    @server.read_resource()
    async def read_resource(uri: AnyUrl) -> str:
        uri_str = str(uri)
        response = await unity_client.send_request(
            {
                "jsonrpc": "2.0",
                "id": f"read_resource_{uri_str}",
                "method": "resources/read",
                "params": {"uri": uri_str},
            }
        )

        if "error" in response:
            error_payload = response["error"]
            return f"Error: {error_payload.get('message', 'Unknown error')}"

        result = response.get("result", {})
        contents = result.get("contents", [])
        if contents and "text" in contents[0]:
            return contents[0]["text"]

        return ""

    return server


async def run_server(
    host: str,
    port: int,
    retry_time: float,
    retry_count: int,
    request_timeout: float,
):
    """Run the MCP server with Windows-compatible stdio transport."""
    logger.info(
        "Starting Unity Code MCP STDIO Bridge host=%s port=%s retry_time=%s retry_count=%s request_timeout=%s log_path=%s max_bytes=%s backups=%s",
        host,
        port,
        retry_time,
        retry_count,
        request_timeout,
        log_file_path,
        LOG_MAX_BYTES,
        LOG_BACKUP_COUNT,
    )

    unity_client: UnityHttpClient | None = None
    try:
        unity_client = UnityHttpClient(
            host,
            port,
            retry_time,
            retry_count,
            port_resolver=get_http_port,
            request_timeout=request_timeout,
        )
        server = create_server(unity_client)

        client_to_server_send, client_to_server_recv = create_memory_object_stream[
            SessionMessage | Exception
        ](max_buffer_size=100)
        server_to_client_send, server_to_client_recv = create_memory_object_stream[
            SessionMessage
        ](max_buffer_size=100)

        async def stdin_reader():
            raw_stdin = sys.stdin.buffer
            last_line_text = ""

            def read_line():
                return raw_stdin.readline()

            try:
                while True:
                    line = await anyio.to_thread.run_sync(read_line)  # type: ignore[attr-defined]
                    if not line:
                        logger.info("stdin EOF")
                        break

                    line_text = line.decode("utf-8").strip()
                    if not line_text:
                        continue
                    last_line_text = line_text

                    logger.debug(
                        "stdin line received bytes=%s preview=%s",
                        len(line),
                        _truncate_for_log(line_text),
                    )

                    message = JSONRPCMessage.model_validate_json(line_text)
                    await client_to_server_send.send(SessionMessage(message=message))
            except anyio.ClosedResourceError:
                logger.info("stdin reader stopped after client stream closed")
            except Exception:
                logger.error(
                    "stdin_reader error line_preview=%s",
                    _truncate_for_log(last_line_text) if last_line_text else "<none>",
                    exc_info=True,
                )
            finally:
                await client_to_server_send.aclose()

        async def stdout_writer():
            raw_stdout = sys.stdout.buffer
            last_message_summary = "<none>"

            def write_data(data: bytes):
                raw_stdout.write(data)
                raw_stdout.flush()

            try:
                async for session_msg in server_to_client_recv:
                    json_str = session_msg.message.model_dump_json(
                        by_alias=True, exclude_none=True
                    )
                    last_message_summary = _truncate_for_log(json_str)
                    await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
                        lambda: write_data((json_str + "\n").encode("utf-8"))
                    )
            except anyio.ClosedResourceError:
                logger.info("stdout writer stopped after server stream closed")
            except Exception:
                logger.error(
                    "stdout_writer error last_message=%s",
                    last_message_summary,
                    exc_info=True,
                )

        try:
            async with create_task_group() as tg:
                tg.start_soon(stdin_reader)
                tg.start_soon(stdout_writer)

                init_options = server.create_initialization_options()
                await server.run(
                    client_to_server_recv, server_to_client_send, init_options
                )

                tg.cancel_scope.cancel()
        except* anyio.ClosedResourceError:
            logger.info("Bridge stream closed during shutdown")
    finally:
        if unity_client is not None:
            await unity_client.disconnect(reason="server-shutdown")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="MCP STDIO Bridge for Unity Code MCP Server",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--retry-time",
        type=float,
        default=2.0,
        help="Seconds between HTTP retry attempts",
    )
    parser.add_argument(
        "--retry-count",
        type=int,
        default=5,
        help="Maximum number of HTTP retry attempts",
    )
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=DEFAULT_REQUEST_TIMEOUT,
        help="Seconds to wait for each Unity HTTP request attempt before retrying or failing",
    )
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    parser.add_argument("--quiet", action="store_true", help="Suppress logging")

    args = parser.parse_args()

    if args.quiet:
        logger.setLevel("WARNING")
    elif args.verbose:
        logger.setLevel("DEBUG")

    host = UNITY_HTTP_HOST
    port = get_http_port()
    logger.info(
        "Unity Code MCP STDIO Bridge starting (Unity at %s, request_timeout=%s)",
        _truncate_for_log(f"{host}:{port}"),
        args.request_timeout,
    )
    asyncio.run(
        run_server(
            host,
            port,
            args.retry_time,
            args.retry_count,
            args.request_timeout,
        )
    )


if __name__ == "__main__":
    main()
