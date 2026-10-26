# Aikido Chromium MCP

A local, visible Chromium MCP for scoped testing of the in-scope `app.aikido.dev` asset. The server opens its own persistent Chromium profile so your existing Chrome and Burp Browser sessions remain untouched.

The dedicated profile connects directly; it does not route through Burp. The MCP records only sanitized app-origin request metadata locally.

## Requirements

- Node.js 22 or newer
- Chromium at `/usr/bin/chromium`
- Codex running locally on this machine

## Install and verify

```bash
cd /home/rkvemula/aikido-chromium-mcp
npm ci
npm test
npm run smoke
```

The smoke test starts a visible Chromium window at `about:blank`, exercises the MCP handshake/status/screenshot tools, then closes the MCP client stdin and verifies the server closes only the profile it launched. It sends no requests to Aikido.

## Register with Codex

Append the block from [`codex-config.example.toml`](./codex-config.example.toml) to `~/.codex/config.toml`; keep any existing settings. Its `env_vars` forwards the current local graphical session to Chromium. Restart Codex so it loads the new MCP tools. This currently running session cannot hot-load a new MCP server.

After the host restarts, call `browser_launch`. Sign in manually in the new Chromium window. This profile persists at `~/.local/share/aikido-chromium-mcp/profile`; Chromium stores its normal local session state there. The MCP does not read or export cookies, passwords, or tokens. Do not use this profile for unrelated accounts.

## Scope and safeguards

- Explicit browser navigation and API reads are restricted to `https://app.aikido.dev`.
- The visible browser does not add `X-Intigriti` to page requests: Chromium can carry overridden request headers through cross-origin redirects without re-running the route handler. Only the explicit `app_api_read` tool sends `X-Intigriti: rkvemula`, and it disables redirects.
- Browser navigations initiated by the Aikido app, including its login flow, may reach an external identity provider without the researcher header. Direct external navigation is blocked, and the MCP does not inspect external-page content; sign in manually in the visible browser.
- `app_api_read` permits only `GET` and `HEAD` on `/api/` paths and allows query filters. It enforces five explicit probes per rolling 60 seconds and does not follow redirects.
- The browser action tools do not expose arbitrary JavaScript. Password, credential, token, and verification-code fields must be entered manually. Form-associated buttons, effective submit controls, and clicks with destructive/action-like labels or paths are blocked.
- The network log is memory-only and contains app request method, sanitized path, and status. It omits query strings, headers, bodies, cookies, and tokens.
- Visible-text snapshots and API read results are returned to the local MCP client and are not persisted by this server. Use only the test account and test data you control.

## Tools

- `browser_launch`, `browser_status`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_network_log`, `browser_click`, `browser_fill`, `browser_close`
- `app_api_read` for one scoped, read-only API request

`npm start` runs the stdio MCP server directly for local troubleshooting. Codex should launch it from the configuration block instead.
