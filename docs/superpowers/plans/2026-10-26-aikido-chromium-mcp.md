# Aikido Chromium MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local MCP server that opens a user-visible Chromium profile for scoped Aikido app review.

**Architecture:** A stdio MCP server uses Playwright to launch system Chromium with a dedicated persistent profile. It restricts explicit navigation and read-only API requests to `app.aikido.dev`, adds the researcher header only to explicit API requests (which do not follow redirects), and keeps sanitized request metadata in memory.

**Tech Stack:** Node.js 22, `@modelcontextprotocol/sdk`, `playwright-core`, system Chromium, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-26-aikido-chromium-mcp-design.md`

## Global Constraints

- Use `/usr/bin/chromium` and a dedicated profile under `~/.local/share/aikido-chromium-mcp`.
- Explicit app navigation/API probes must use `https://app.aikido.dev` and `X-Intigriti: rkvemula`.
- Explicit API probes are read-only (`GET`/`HEAD`) and capped at five in any rolling 60-second window.
- Do not log or export credentials, cookies, authorization values, query strings, or response bodies.
- Keep the existing Chromium and Burp Browser profiles untouched; the user performs sign-in.
- Do not actively test or inspect out-of-scope hosts.

## Review Focus

- Browser page requests must not receive the researcher header because Playwright route header overrides can persist across cross-origin redirects; cover server redirects, JavaScript location changes, and app-opened auth windows with real local Chromium tests. Explicit API reads carry the header and do not follow redirects.
- External resources and app-initiated authentication navigations must not receive the researcher header or be logged; direct navigation to other origins must be blocked; cover with route-policy tests.
- URLs containing credentials, fragments, query strings, or lookalike hosts must not be navigated to; cover with URL-policy tests.
- Password/secret/token fields must not be filled by MCP tools; cover with locator-policy tests.
- Browser/API failures must not expose Playwright diagnostics containing URLs or Cookie headers; cover with sentinel-secret tests.
- The sixth explicit API probe in a rolling minute must be rejected, and the budget must recover after expiry; cover with a clock-injected limiter test.
- Closing Chromium or MCP must not kill the user's existing browsers or erase the dedicated profile; cover with lifecycle smoke tests.

---

### Task 1: Scope policy and request budget

**Files:**
- Create: `package.json`
- Create: `src/policy.mjs`
- Test: `test/policy.test.mjs`

**Interfaces:**
- `validateAppUrl(value: string): URL` accepts only HTTPS URLs whose hostname is exactly `app.aikido.dev`; it rejects credentials, fragments, and non-app origins.
- `validateApiPath(path: string): URL` accepts only app-relative `/api/` paths, permits query parameters for documented filters, and rejects absolute/protocol-relative URLs and fragments.
- `headersForApiUrl(url: URL, baseHeaders: Record<string, string>): Record<string, string>` adds `X-Intigriti: rkvemula` only to explicit API requests for the exact app origin.
- `sanitizeAppPath(url: URL): string` omits query and fragment and redacts UUID-like path segments.
- `ProbeBudget(limit = 5, windowMs = 60_000, now = Date.now)` exposes `consume(): void` and throws on the sixth call in-window.

- [ ] **Step 1: Add failing policy tests** for exact-host page URLs, rejection of queries on explicit navigation, app-relative API path/query acceptance, rejection of external API paths, header isolation, URL redaction, and five-per-minute budget behavior with a fake clock.
- [ ] **Step 2: Run `node test/policy.test.mjs`** and confirm five tests fail with `policy module is not implemented`.
- [ ] **Step 3: Implement the five policy interfaces** in `src/policy.mjs`; keep them independent of Playwright and MCP transport.
- [ ] **Step 4: Run `node test/policy.test.mjs`** and confirm all policy tests pass.

### Task 2: Visible Chromium controller and MCP tools

**Files:**
- Create: `src/browser.mjs`
- Create: `src/server.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- `BrowserController.launch(): Promise<void>` launches `/usr/bin/chromium` visibly with the dedicated profile and keeps current user profiles untouched.
- `BrowserController.close(): Promise<void>` closes only the dedicated Playwright context and its Chromium process, preserving the profile and all other browsers.
- `BrowserController.navigate(url: string): Promise<void>` uses `validateAppUrl` for explicit navigation and rejects query strings/fragments.
- `BrowserController.snapshot(): Promise<{url: string; title: string; text: string}>` returns current visible app content without URL query strings.
- MCP tools: `browser_launch`, `browser_status`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_fill`, `browser_network_log`, `browser_close`, and `app_api_read`.
- `app_api_read({path, method})` uses `validateApiPath`, accepts app-relative `/api/` paths with query filters and only `GET`/`HEAD`, calls `ProbeBudget.consume()`, and returns the response for the user-owned test account without persisting it.

- [ ] **Step 1: Add failing server tests** for tool registration, app-only navigation, header isolation, external resource/auth-redirect handling, click restrictions, password/secret field rejection, API method/rate limits, and profile-safe close behavior.
- [ ] **Step 2: Run `node test/server.test.mjs`** and confirm the tests fail because the browser controller/server is absent.
- [ ] **Step 3: Implement Playwright routing** so browser page requests never receive the researcher header (avoiding header retention across redirects) and only sanitized app-origin request metadata is retained in a 200-entry in-memory buffer; app-initiated auth navigations may pass without instrumentation, and direct external navigation is blocked.
- [ ] **Step 4: Implement the MCP tools** with screenshot output as image content, bounded visible-text output, password/secret fill rejection, same-origin-only clicks, non-submitting/non-destructive click guards, `browser_close`, and no arbitrary JavaScript execution.
- [ ] **Step 5: Run `node test/server.test.mjs`** and confirm all server tests pass.

### Task 3: Run instructions and MCP registration handoff

**Files:**
- Create: `README.md`
- Create: `codex-config.example.toml`
- Create: `.gitignore`
- Create: `test/run.mjs`
- Create: `test/smoke-mcp.mjs`
- Modify: `package.json` scripts

- [ ] **Step 1: Document install, start, user sign-in, request budget, scope boundaries, and clean shutdown** in `README.md`; state that this creates a separate Chromium profile and does not reuse/export cookies.
- [ ] **Step 2: Add a Codex MCP configuration example** that starts `node /home/rkvemula/aikido-chromium-mcp/src/server.mjs` over stdio and forwards local display environment variables; do not overwrite the user's existing Codex configuration.
- [ ] **Step 3: Set `npm test` to `node test/run.mjs` (explicitly importing test files because this Node build's `--test` discovery is broken), add `npm start`, and run `npm test` from a clean install.
- [ ] **Step 4: Smoke-test the MCP handshake and launch Chromium to `about:blank`**, verify status/screenshot behavior and stdin-EOF browser cleanup through `npm run smoke`, and confirm no external target request occurs during the smoke test.
- [ ] **Step 5: Report the config block and required MCP-host restart**; the new server cannot appear in the current tool list until the host reloads it.
