import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {BrowserController} from '../src/browser.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('real Chromium strips the researcher header on server, JS, and popup app-to-external navigations', {timeout: 20_000}, async () => {
  const externalHeaders = [];
  const external = createServer((request, response) => {
    externalHeaders.push(request.headers);
    if (request.url === '/auth-start') {
      response.writeHead(200, {'content-type': 'text/html'});
      response.end(`<script>window.location = ${JSON.stringify(`${externalOrigin}/auth-done`)};</script>`);
      return;
    }
    if (request.url === '/server-auth-start') {
      response.writeHead(200, {'content-type': 'text/html'});
      response.end(`<script>window.location = ${JSON.stringify(`${externalOrigin}/server-auth-done`)};</script>`);
      return;
    }
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end('local redirect destination');
  });
  const externalOrigin = await listen(external);
  const app = createServer((request, response) => {
    if (request.url === '/popup') {
      response.writeHead(200, {'content-type': 'text/html'});
      response.end(`<button id="open-login">Open login</button><script>document.querySelector('#open-login').onclick=()=>window.open(${JSON.stringify(`${externalOrigin}/popup-landing`)});</script>`);
      return;
    }
    if (request.url === '/client-redirect') {
      response.writeHead(200, {'content-type': 'text/html'});
      response.end(`<script>window.location = ${JSON.stringify(`${externalOrigin}/auth-start`)};</script>`);
      return;
    }
    if (request.url === '/server-auth') {
      response.writeHead(302, {location: `${externalOrigin}/server-auth-start`});
      response.end();
      return;
    }
    response.writeHead(302, {location: `${externalOrigin}/server-landing`});
    response.end();
  });
  const appOrigin = await listen(app);
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({extraHTTPHeaders: {'X-Intigriti': 'rkvemula'}});
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-redirect-integration', appOrigin});
  controller.context = context;
  controller.page = await context.newPage();
  await context.route('**/*', (route) => controller.routeRequest(route));
  context.on('response', (response) => controller.recordResponse(response));
  context.on('requestfailed', (request) => controller.recordFailure(request));

  try {
    await controller.page.goto(`${appOrigin}/start`, {waitUntil: 'domcontentloaded'});
    assert.equal(await controller.page.locator('body').innerText(), 'local redirect destination');
    await controller.page.goto(`${appOrigin}/server-auth`, {waitUntil: 'domcontentloaded'});
    await controller.page.waitForURL(`${externalOrigin}/server-auth-done`);
    await controller.page.goto(`${appOrigin}/client-redirect`, {waitUntil: 'domcontentloaded'});
    await controller.page.waitForURL(`${externalOrigin}/auth-done`);
    await controller.page.goto(`${appOrigin}/popup`, {waitUntil: 'domcontentloaded'});
    const popupWait = controller.page.waitForEvent('popup');
    await controller.page.locator('#open-login').click();
    const popup = await popupWait;
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), `${externalOrigin}/popup-landing`);
    assert.equal(externalHeaders.length, 6);
    assert.equal(externalHeaders.some((headers) => headers['x-intigriti'] !== undefined), false);
  } finally {
    await controller.close();
    await browser.close();
    await close(app);
    await close(external);
  }
});

test('Chromium normalizes default and invalid form button types to submit', {timeout: 20_000}, async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {'content-type': 'text/html'});
    response.end('<form id="test-form"><label>Value <input id="otpValue" name="access_token" autocomplete="one-time-code"></label><button id="default">Details</button><button id="invalid" type="mystery">Overview</button></form><script>document.querySelector("form").addEventListener("submit", event => { event.preventDefault(); document.body.dataset.submitted = "yes"; });</script>');
  });
  const origin = await listen(server);
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext();
  const page = await context.newPage();
  const {BrowserController, isSafeClickTarget} = await import('../src/browser.mjs');
  const controller = new BrowserController({chromiumImpl: {}, userDataDir: '/tmp/aikido-form-integration', appOrigin: origin});
  controller.context = context;
  controller.page = page;

  try {
    await page.goto(origin);
    const results = await page.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
      label: button.innerText,
      typeAttribute: button.getAttribute('type'),
      effectiveType: button.type,
      belongsToForm: Boolean(button.form),
    })));
    assert.deepEqual(results.map(({effectiveType}) => effectiveType), ['submit', 'submit']);
    assert.deepEqual(results.map(({typeAttribute}) => typeAttribute), [null, 'mystery']);
    for (const button of results) {
      assert.equal(isSafeClickTarget({role: 'button', name: button.label, type: button.effectiveType, formAssociated: button.belongsToForm}), false);
    }
    await assert.rejects(() => controller.click({role: 'button', name: 'Details'}), /safe-action policy/);
    assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
    await assert.rejects(() => controller.fill({label: 'Value', value: 'synthetic-one-time-code'}), /Sensitive fields/);
    assert.equal(await page.locator('#otpValue').inputValue(), '');
  } finally {
    await controller.close();
    await browser.close();
    await close(server);
  }
});

