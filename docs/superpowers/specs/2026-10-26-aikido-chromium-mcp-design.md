# Aikido Chromium MCP Design

## Intent

Give Codex a local, visible Chromium session for the user's Aikido test account so the user can complete sign-in and help with scoped application review.

## Selected approach

Use a small local Node MCP server backed by Playwright and system Chromium. It launches a separate persistent profile because the existing Chromium and Burp Browser have no remote-debugging port. The user signs into this profile manually; existing browser profiles and credentials remain untouched.

Direct browser connections avoid the Burp certificate-trust issue. The MCP will target `app.aikido.dev` only for explicit navigation and API probes. Normal authentication redirects and page resources may load as part of the application flow, but the MCP will not inspect or add the researcher header to other origins. Direct external navigation is blocked.

## Tool surface and safeguards

- Browser status, app navigation, visible-text snapshot, screenshot, click, fill, close, and sanitized app-request log tools.
- A read-only API request tool limited to `GET` and `HEAD` on `https://app.aikido.dev`; it adds `X-Intigriti: rkvemula` only to that origin.
- Explicit API probes are limited to five per rolling 60 seconds. Normal page resources and user-driven navigation are not counted as probes.
- Network metadata kept in memory only: method, sanitized path, and status for `app.aikido.dev`; no query strings, headers, bodies, cookies, or tokens are logged.
- No arbitrary JavaScript tool, cross-origin API tool, cookie export, or automated scanner.
- Browser clicks are limited to non-submitting, non-destructive controls; the MCP rejects obvious submit/delete actions and never submits forms.
- The user enters credentials and verification codes manually. The MCP blocks filling password/secret/token fields.
- MCP server registration is documented without overwriting existing settings; a host restart is required before its tools appear.

## Non-goals

- Attaching to the existing Burp Browser or existing personal Chromium profile.
- Testing `*.aikido.dev` hosts other than the listed in-scope app asset.
- Performing state-changing tests or accessing another party's data.
