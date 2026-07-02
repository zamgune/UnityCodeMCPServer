# unity-code-mcp-stdio

MCP STDIO bridge for the [Unity Code MCP Server](https://github.com/zamgune/UnityCodeMCPServer) Unity package. It forwards MCP JSON-RPC from stdio to a Unity Editor running the UnityCodeMcpServer package, over a file-based transport that survives domain reloads.

The Unity package must be installed in the target project (see the repository README for setup). Then register the bridge with any MCP client:

```bash
uvx unity-code-mcp-stdio --project-root /path/to/UnityProject --request-timeout 240
```

Also ships a one-shot `unity-code` CLI, so shell-capable agents can call Unity tools without MCP registration:

```bash
uvx --from unity-code-mcp-stdio unity-code --project-root /path/to/UnityProject list
uvx --from unity-code-mcp-stdio unity-code --project-root /path/to/UnityProject exec 'return Application.unityVersion;'
```

Full documentation: https://github.com/zamgune/UnityCodeMCPServer
