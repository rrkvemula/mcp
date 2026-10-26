import assert from 'node:assert/strict';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ProbeBudget} from '../src/policy.mjs';

const browserModule = await import('../src/browser.mjs').catch(() => null);
const serverModule = await import('../src/server.mjs').catch(() => null);

function getBrowserModule() {
  assert.ok(browserModule, 'browser module is not implemented');
  return browserModule;
}

function getServerModule() {
  assert.ok(serverModule, 'MCP server module is not implemented');
  return serverModule;
}

function fakeBrowser(overrides = {}) {
  return {
    launch: async () => {},
    close: async () => {},
    status: async () => ({running: true, url: 'https://app.aikido.dev/'}),
    navigate: async () => {},
    snapshot: async () => ({url: 'https://app.aikido.dev/', title: 'Aikido', text: 'Dashboard'}),
    screenshot: async () => Buffer.from('png'),
    click: async () => {},
    fill: async () => {},
    networkLog: () => [],
    apiRead: async () => ({status: 200, contentType: 'application/json', body: '{"ok":true}'}),
    ...overrides,
  };
}

async function connectClient(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test-client', version: '1.0.0'});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {client, close: async () => { await client.close(); await server.close(); }};
}

test('routes only app requests through the researcher-header/log path', () => {
  const {decideRequest} = getBrowserModule();

  assert.deepEqual(decideRequest({url: 'https://app.aikido.dev/api/issues'}), {
    action: 'continue', addResearcherHeader: true, log: true,
  });
  assert.deepEqual(decideRequest({url: 'https://cdn.aikido.dev/assets/app.js', resourceType: 'script'}), {
    action: 'continue', addResearcherHeader: false, log: false,
  });
  assert.deepEqual(decideRequest({
    url: 'https://login.example.test/authorize',
    resourceType: 'document',
    isNavigationRequest: true,
    redirectedFromUrl: 'https://app.aikido.dev/login',
  }), {action: 'continue', addResearcherHeader: false, log: false});
  assert.deepEqual(decideRequest({
    url: 'https://outside.example.test/',
    resourceType: 'document',
    isNavigationRequest: true,
  }), {action: 'abort', addResearcherHeader: false, log: false});
});

test('rejects destructive, submitting, and external click targets', () => {
  const {isSafeClickTarget} = getBrowserModule();

  assert.equal(isSafeClickTarget({role: 'link', name: 'Issues', href: '/issues'}), true);
  assert.equal(isSafeClickTarget({role: 'link', name: 'Scans', href: '/scans'}), true);
  assert.equal(isSafeClickTarget({role: 'button', name: 'Start AI pentest', type: 'button'}), false);
  assert.equal(isSafeClickTarget({role: 'button', name: 'Connect repository', type: 'button'}), false);
  assert.equal(isSafeClickTarget({role: 'button', name: 'Delete project', type: 'button'}), false);
  assert.equal(isSafeClickTarget({role: 'button', name: 'Save', type: 'submit'}), false);
  assert.equal(isSafeClickTarget({role: 'link', name: 'External', href: 'https://outside.test/'}), false);
});

test('blocks filling password, secret, and token fields', () => {
  const {isSensitiveFillTarget} = getBrowserModule();

  assert.equal(isSensitiveFillTarget({type: 'password', label: 'Password'}), true);
  assert.equal(isSensitiveFillTarget({type: 'text', label: 'API token'}), true);
  assert.equal(isSensitiveFillTarget({type: 'email', label: 'Work email'}), false);
});

test('uses a dedicated Chromium profile and closes only its own context', async () => {
  const {BrowserController} = getBrowserModule();
  let launchOptions;
  let closeCount = 0;
  const page = {on() {}, url: () => 'about:blank', title: async () => ''};
  const context = {
    pages: () => [page],
    route: async () => {},
    on() {},
    close: async () => { closeCount += 1; },
  };
  const controller = new BrowserController({
    chromiumImpl: {launchPersistentContext: async (_profile, options) => { launchOptions = options; return context; }},
    userDataDir: '/tmp/aikido-mcp-test-profile',
    environment: {WAYLAND_DISPLAY: 'wayland-0'},
  });

  await controller.launch();
  await controller.close();
  assert.equal(launchOptions.executablePath, '/usr/bin/chromium');
  assert.equal(launchOptions.headless, false);
  assert.ok(launchOptions.args.includes('--disable-background-networking'));
  assert.ok(launchOptions.args.includes('--ozone-platform=wayland'));
  assert.equal(closeCount, 1);
});

test('screenshots the blank smoke page but not an external authentication page', async () => {
  const {BrowserController} = getBrowserModule();
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-screenshot-test'});
  controller.context = {};
  controller.page = {url: () => 'about:blank', screenshot: async () => Buffer.from('png')};

  assert.equal((await controller.screenshot()).toString(), 'png');
  controller.page = {url: () => 'https://login.example.test/', screenshot: async () => Buffer.from('private')};
  await assert.rejects(() => controller.screenshot(), /app\.aikido\.dev/);
});

test('status reports about:blank without labeling it an external auth page', async () => {
  const {BrowserController} = getBrowserModule();
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-status-test'});
  controller.context = {};
  controller.page = {url: () => 'about:blank', title: async () => ''};

  assert.deepEqual(await controller.status(), {running: true, url: 'about:blank', title: ''});
});

test('the real route handler attaches the header only to app traffic and logs sanitized metadata', async () => {
  const {BrowserController} = getBrowserModule();
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const request = {
    url: () => `https://app.aikido.dev/api/teams/${id}?secret=private`,
    method: () => 'GET',
    headers: () => ({accept: 'application/json', 'x-intigriti': 'wrong'}),
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
    redirectedFrom: () => null,
  };
  let continued;
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-route-test'});

  await controller.routeRequest({
    request: () => request,
    continue: async (options) => { continued = options; },
    abort: async () => assert.fail('app request should continue'),
  });
  controller.recordResponse({request: () => request, status: () => 200});

  assert.equal(continued.headers['X-Intigriti'], 'rkvemula');
  assert.equal(continued.headers['x-intigriti'], undefined);
  assert.deepEqual(controller.networkLog(), [{method: 'GET', path: `/api/teams/{id}`, status: 200}]);
});

test('API reads attach the researcher header and do not follow redirects', async () => {
  const {BrowserController} = getBrowserModule();
  let call;
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-api-test'});
  controller.context = {
    request: {
      fetch: async (url, options) => {
        call = {url, options};
        return {status: () => 200, headers: () => ({'content-type': 'application/json'}), text: async () => '{"ok":true}'};
      },
    },
  };

  const response = await controller.apiRead('/api/issues/list?status=open', 'GET');
  assert.equal(call.url, 'https://app.aikido.dev/api/issues/list?status=open');
  assert.equal(call.options.headers['X-Intigriti'], 'rkvemula');
  assert.equal(call.options.maxRedirects, 0);
  assert.equal(response.status, 200);
});

test('an API read consumes the MCP probe budget only once', async () => {
  const {BrowserController} = getBrowserModule();
  const {createMcpServer} = getServerModule();
  const budget = new ProbeBudget(1);
  let fetchCount = 0;
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-budget-test'});
  controller.probeBudget = budget;
  controller.context = {
    request: {
      fetch: async () => {
        fetchCount += 1;
        return {status: () => 200, headers: () => ({'content-type': 'application/json'}), text: async () => '{"ok":true}'};
      },
    },
  };
  const server = createMcpServer({browserController: controller, probeBudget: budget});
  const {client, close} = await connectClient(server);

  try {
    const result = await client.callTool({name: 'app_api_read', arguments: {path: '/api/issues/list', method: 'GET'}});
    assert.equal(result.isError, undefined);
    assert.equal(fetchCount, 1);
  } finally {
    await close();
  }
});

test('registers the scoped browser tools with the MCP client', async () => {
  const {createMcpServer} = getServerModule();
  const server = createMcpServer({browserController: fakeBrowser(), probeBudget: new ProbeBudget()});
  const {client, close} = await connectClient(server);

  try {
    const {tools} = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'app_api_read', 'browser_click', 'browser_close', 'browser_fill', 'browser_launch',
        'browser_navigate', 'browser_network_log', 'browser_screenshot', 'browser_snapshot', 'browser_status',
      ].sort(),
    );
  } finally {
    await close();
  }
});

test('browser navigation results redact resource identifiers', async () => {
  const {createMcpServer} = getServerModule();
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const navigations = [];
  const server = createMcpServer({browserController: fakeBrowser({navigate: async (url) => navigations.push(url.href)})});
  const {client, close} = await connectClient(server);

  try {
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: {url: `https://app.aikido.dev/projects/${id}`},
    });
    assert.equal(navigations.length, 1);
    assert.match(result.content[0].text, /\/projects\/{id}/);
    assert.doesNotMatch(result.content[0].text, new RegExp(id));
  } finally {
    await close();
  }
});

test('browser click and fill results do not echo labels or entered values', async () => {
  const {createMcpServer} = getServerModule();
  const server = createMcpServer({browserController: fakeBrowser()});
  const {client, close} = await connectClient(server);

  try {
    const click = await client.callTool({
      name: 'browser_click',
      arguments: {role: 'tab', name: 'Private workspace name'},
    });
    const fill = await client.callTool({
      name: 'browser_fill',
      arguments: {label: 'Contact email', value: 'researcher-private@example.test'},
    });
    const output = `${click.content[0].text} ${fill.content[0].text}`;
    assert.doesNotMatch(output, /Private workspace name|Contact email|researcher-private@example\.test/);
  } finally {
    await close();
  }
});

test('only sends allowed app navigation and enforces read-only API methods and budget', async () => {
  const {createMcpServer} = getServerModule();
  const navigations = [];
  const reads = [];
  const browser = fakeBrowser({
    navigate: async (url) => navigations.push(url.href),
    apiRead: async (path, method) => { reads.push({path, method}); return {status: 200, contentType: 'application/json', body: '{"ok":true}'}; },
  });
  const server = createMcpServer({browserController: browser, probeBudget: new ProbeBudget(1)});
  const {client, close} = await connectClient(server);

  try {
    const blockedNavigation = await client.callTool({name: 'browser_navigate', arguments: {url: 'https://outside.test/'}});
    assert.equal(blockedNavigation.isError, true);
    assert.deepEqual(navigations, []);

    const success = await client.callTool({name: 'app_api_read', arguments: {path: '/api/issues/list?status=open', method: 'GET'}});
    assert.equal(success.isError, undefined);
    assert.equal(reads[0].path, '/api/issues/list?status=open');
    assert.equal(reads[0].method, 'GET');

    const disallowedMethod = await client.callTool({name: 'app_api_read', arguments: {path: '/api/issues/list', method: 'POST'}});
    assert.equal(disallowedMethod.isError, true);
    assert.equal(reads.length, 1);

    const overBudget = await client.callTool({name: 'app_api_read', arguments: {path: '/api/issues/list', method: 'GET'}});
    assert.equal(overBudget.isError, true);
    assert.equal(reads.length, 1);
  } finally {
    await close();
  }
});
