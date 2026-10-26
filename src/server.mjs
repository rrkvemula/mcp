import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {ProbeBudget, sanitizeAppPath, validateAppUrl, validateApiPath} from './policy.mjs';
import {BrowserController} from './browser.mjs';

function textResult(value) {
  return {content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}]};
}

export function createMcpServer({browserController = new BrowserController(), probeBudget = new ProbeBudget()} = {}) {
  const server = new McpServer({name: 'aikido-chromium', version: '0.1.0'});

  server.registerTool('browser_launch', {
    description: 'Launch the dedicated visible Chromium profile for the in-scope Aikido app. Sign in manually.',
    inputSchema: z.object({}),
  }, async () => {
    await browserController.launch();
    return textResult({launched: true, message: 'Dedicated Chromium is open; enter credentials and verification codes manually.'});
  });

  server.registerTool('browser_status', {
    description: 'Return the current Aikido page status without query strings or session data.',
    inputSchema: z.object({}),
  }, async () => textResult(await browserController.status()));

  server.registerTool('browser_navigate', {
    description: 'Navigate to a clean HTTPS URL on app.aikido.dev only.',
    inputSchema: z.object({url: z.string().min(1)}),
  }, async ({url}) => {
    const safeUrl = validateAppUrl(url);
    await browserController.navigate(safeUrl.href);
    return textResult({navigated: true, url: safeUrl.origin + sanitizeAppPath(safeUrl)});
  });

  server.registerTool('browser_snapshot', {
    description: 'Read visible text from the current app.aikido.dev page, capped at 12,000 characters.',
    inputSchema: z.object({}),
  }, async () => textResult(await browserController.snapshot()));

  server.registerTool('browser_screenshot', {
    description: 'Capture the current app.aikido.dev page as an image.',
    inputSchema: z.object({}),
  }, async () => ({content: [{type: 'image', data: (await browserController.screenshot()).toString('base64'), mimeType: 'image/png'}]}));

  server.registerTool('browser_click', {
    description: 'Click a single non-submitting, non-destructive button, link, or tab on app.aikido.dev.',
    inputSchema: z.object({role: z.enum(['button', 'link', 'tab']), name: z.string().min(1)}),
  }, async (args) => {
    await browserController.click(args);
    return textResult({clicked: true});
  });

  server.registerTool('browser_fill', {
    description: 'Fill a non-sensitive labeled field on app.aikido.dev. Password, secret, token, and credential fields are blocked.',
    inputSchema: z.object({label: z.string().min(1), value: z.string()}),
  }, async (args) => {
    await browserController.fill(args);
    return textResult({filled: true});
  });

  server.registerTool('browser_network_log', {
    description: 'Read recent in-memory app request metadata only: method, sanitized path, and status.',
    inputSchema: z.object({limit: z.number().int().min(1).max(200).optional()}),
  }, async ({limit}) => textResult(browserController.networkLog(limit)));

  server.registerTool('browser_close', {
    description: 'Close only the dedicated Chromium profile managed by this MCP. The profile data remains on disk.',
    inputSchema: z.object({}),
  }, async () => {
    await browserController.close();
    return textResult({closed: true});
  });

  server.registerTool('app_api_read', {
    description: 'Make one GET or HEAD request to an app-relative /api/ path with the researcher header. Limited to five probes per 60 seconds.',
    inputSchema: z.object({path: z.string().min(1), method: z.enum(['GET', 'HEAD']).default('GET')}),
  }, async ({path, method}) => {
    const url = validateApiPath(path);
    probeBudget.consume();
    return textResult(await browserController.apiRead(`${url.pathname}${url.search}`, method));
  });

  return server;
}

export async function main() {
  const browserController = new BrowserController();
  const server = createMcpServer({browserController});
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await browserController.close().catch(() => {});
    await server.close().catch(() => {});
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`aikido-chromium-mcp: ${error.message}\n`);
    process.exitCode = 1;
  });
}
