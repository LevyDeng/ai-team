# MCP OAuth 2.1 远程网关

为 Gemini 网页版（Connected Apps / Developer Mode）或其他支持 OAuth 2.1 + PKCE 的远程 MCP 客户端提供受保护的 HTTPS 网关，后端通过 SSH 反向隧道连接本机 `Windows-MCP`。

## 核心保护

- 网关仅监听 `127.0.0.1:18080`，通过 Nginx / Cloudflare Tunnel 暴露 HTTPS。
- 支持 RFC 9728（`/.well-known/oauth-protected-resource`）、RFC 8414（`/.well-known/oauth-authorization-server`）、RFC 7591（`/register`）与 OAuth 2.1 + PKCE（`S256`）授权，且 `/authorize` 强制校验网关授权密码。
- 默认白名单仅放行只读工具（`ControlStatus,DisplayInventory,Screenshot,Snapshot`），在 `tools/list` 和 `tools/call` 两处同时拦截非白名单工具。
- 从 `TUNNEL_ENV_FILE`（如 `/home/ptrees/.windows-mcp/tunnel.env`）动态读取 `WINDOWS_MCP_URL` 与 `WINDOWS_MCP_SECRET`，不把静态密钥暴露给公网客户端。

## Project directory access

The container enables project-directory tools by default. On a Linux SSH location in AI Team, enable remote configuration sync and start the MCP tunnel. AI Team then creates a separate loopback SSH forward for directory approvals. The gateway reads its address and credential from the same protected tunnel environment file.

Refresh the tool schema in Gemini Developer Mode. Ask Gemini to request read or read-write access to the absolute path of an existing Windows project directory. Confirm the request in AI Team. Gemini can check approval and reuse the returned request ID for subsequent file operations. Access ends when you revoke it in the location panel, stop the tunnel, or exit AI Team.

The local service checks the approved root and relative path for every operation. The file tools support listing, metadata, bounded text search, and reading and writing UTF-8 files up to 128 KiB. They reject links and protected paths. Updates require the revision returned by a read. Use the revision `create` for a new file.

The gateway binds each request ID to its OAuth authorization. Gemini does not provide a verified chat identifier. Keep the request ID in the conversation where it was issued. Gemini controls its own confirmation prompts for write operations.
