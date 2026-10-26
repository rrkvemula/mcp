import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(projectRoot, 'src', 'server.mjs');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: projectRoot,
  env: Object.fromEntries(
    ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  ),
  stderr: 'inherit',
});
const client = new Client({name: 'aikido-chromium-smoke', version: '0.1.0'});

function textResult(result) {
  if (result.isError) {
    const detail = result.content?.find((item) => item.type === 'text')?.text ?? 'MCP tool failed';
    throw new Error(detail);
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, 'expected an MCP text result');
  return JSON.parse(text);
}

await client.connect(transport);
try {
  const {tools} = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'browser_launch'));
  assert.ok(tools.some((tool) => tool.name === 'app_api_read'));

  const launch = await client.callTool({name: 'browser_launch', arguments: {}});
  assert.equal(textResult(launch).launched, true);

  const status = textResult(await client.callTool({name: 'browser_status', arguments: {}}));
  assert.equal(status.running, true);
  assert.equal(status.url, 'about:blank');

  const screenshot = await client.callTool({name: 'browser_screenshot', arguments: {}});
  assert.ok(screenshot.content?.some((item) => item.type === 'image'));

  const log = textResult(await client.callTool({name: 'browser_network_log', arguments: {}}));
  assert.deepEqual(log, []);

  const close = await client.callTool({name: 'browser_close', arguments: {}});
  assert.equal(textResult(close).closed, true);
  process.stdout.write('MCP stdio handshake and visible Chromium smoke passed; no Aikido requests sent.\n');
} finally {
  await client.close();
}
