import {mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {
  APP_ORIGIN,
  headersForUrl,
  sanitizeAppPath,
  validateApiPath,
  validateAppUrl,
} from './policy.mjs';

const MAX_LOG_ENTRIES = 200;
const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_API_BODY_CHARS = 12_000;
const BLOCKED_ACTION = /\b(delete|remove|disable|confirm|submit|send|invite|import|create|purchase|pay|checkout|logout|log out|revoke|disconnect|save|update|apply|install|start|run|launch|execute|scan|deploy|publish|authorize|grant|connect|add)\b/i;
const SENSITIVE_FIELD = /\b(password|secret|token|api[\s_-]*key|credential|cookie|authorization|otp|one[\s_-]*time|2fa|recovery[\s_-]*code)\b/i;

function currentAppUrl(page) {
  const current = page.url();
  if (current === 'about:blank') return current;

  let url;
  try {
    url = new URL(current);
  } catch {
    return '[unavailable]';
  }

  if (url.origin !== APP_ORIGIN) return '[authentication page]';
  return `${APP_ORIGIN}${sanitizeAppPath(url)}`;
}

export function decideRequest({url, resourceType = 'other', isNavigationRequest = false, redirectedFromUrl = null}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {action: 'abort', addResearcherHeader: false, log: false};
  }

  if (parsed.origin === APP_ORIGIN) {
    return {action: 'continue', addResearcherHeader: true, log: true};
  }

  if (isNavigationRequest && redirectedFromUrl) {
    try {
      if (new URL(redirectedFromUrl).origin === APP_ORIGIN) {
        return {action: 'continue', addResearcherHeader: false, log: false};
      }
    } catch {
      return {action: 'abort', addResearcherHeader: false, log: false};
    }
  }

  if (isNavigationRequest || resourceType === 'document') {
    return {action: 'abort', addResearcherHeader: false, log: false};
  }

  return {action: 'continue', addResearcherHeader: false, log: false};
}

export function isSafeClickTarget({role, name, type = '', href = null}) {
  if (!['button', 'link', 'tab'].includes(role) || typeof name !== 'string' || name.trim() === '') {
    return false;
  }
  if (BLOCKED_ACTION.test(name) || (role === 'button' && String(type).toLowerCase() === 'submit')) {
    return false;
  }

  if (role === 'link') {
    if (typeof href !== 'string' || href.trim() === '') return false;
    try {
      if (new URL(href, APP_ORIGIN).origin !== APP_ORIGIN) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export function isSensitiveFillTarget({type = '', label = '', name = '', placeholder = ''}) {
  if (String(type).toLowerCase() === 'password') return true;
  return SENSITIVE_FIELD.test([label, name, placeholder].join(' '));
}

export class BrowserController {
  constructor({chromiumImpl = chromium, userDataDir = path.join(os.homedir(), '.local', 'share', 'aikido-chromium-mcp', 'profile'), environment = process.env} = {}) {
    this.chromium = chromiumImpl;
    this.userDataDir = userDataDir;
    this.environment = environment;
    this.context = null;
    this.page = null;
    this.pending = new Map();
    this.entries = [];
  }

  async launch() {
    if (this.context) return;
    await mkdir(this.userDataDir, {recursive: true, mode: 0o700});
    this.context = await this.chromium.launchPersistentContext(this.userDataDir, {
      executablePath: '/usr/bin/chromium',
      headless: false,
      acceptDownloads: false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        ...(this.environment.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
      ],
    });

    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.context.route('**/*', (route) => this.routeRequest(route));
    this.context.on('response', (response) => this.recordResponse(response));
    this.context.on('requestfailed', (request) => this.recordFailure(request));
  }

  async routeRequest(route) {
    const request = route.request();
    const previous = request.redirectedFrom();
    const decision = decideRequest({
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigationRequest: request.isNavigationRequest(),
      redirectedFromUrl: previous?.url() ?? null,
    });

    if (decision.action === 'abort') {
      await route.abort('blockedbyclient');
      return;
    }

    const url = new URL(request.url());
    if (decision.log) {
      this.pending.set(request, {method: request.method(), path: sanitizeAppPath(url)});
    }

    const headers = headersForUrl(url, request.headers());
    await route.continue({headers});
  }

  recordResponse(response) {
    const request = response.request();
    const entry = this.pending.get(request);
    if (!entry) return;
    this.pending.delete(request);
    this.pushLog({...entry, status: response.status()});
  }

  recordFailure(request) {
    const entry = this.pending.get(request);
    if (!entry) return;
    this.pending.delete(request);
    this.pushLog({...entry, status: null});
  }

  pushLog(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.pending.clear();
    if (context) await context.close();
  }

  async navigate(value) {
    const url = validateAppUrl(value);
    const page = this.requireAppPage();
    await page.goto(url.href, {waitUntil: 'domcontentloaded'});
  }

  async status() {
    if (!this.context || !this.page) return {running: false};
    const currentUrl = this.page.url();
    if (currentUrl === 'about:blank') {
      return {running: true, url: 'about:blank', title: await this.page.title()};
    }
    const current = new URL(currentUrl);
    return {
      running: true,
      url: current.origin === APP_ORIGIN ? currentAppUrl(this.page) : '[authentication page]',
      title: current.origin === APP_ORIGIN ? await this.page.title() : '[authentication page]',
    };
  }

  async snapshot() {
    const page = this.requireAppPage();
    const text = await page.locator('body').innerText({timeout: 5_000}).catch(() => '');
    return {
      url: currentAppUrl(page),
      title: await page.title(),
      text: text.slice(0, MAX_SNAPSHOT_CHARS),
      truncated: text.length > MAX_SNAPSHOT_CHARS,
    };
  }

  async screenshot() {
    if (!this.context || !this.page) throw new Error('Browser is not running');
    const current = this.page.url();
    if (current !== 'about:blank' && new URL(current).origin !== APP_ORIGIN) {
      throw new Error('Screenshots are available only on app.aikido.dev or about:blank');
    }
    const page = this.page;
    return page.screenshot({type: 'png'});
  }

  networkLog(limit = 50) {
    const capped = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 50));
    return this.entries.slice(-capped).map((entry) => ({...entry}));
  }

  async click({role, name}) {
    const page = this.requireAppPage();
    const target = page.getByRole(role, {name, exact: true});
    if (await target.count() !== 1) throw new Error('Click target must match exactly one visible control');
    const info = await target.evaluate((element) => ({
      type: element.getAttribute('type') ?? '',
      href: element.getAttribute('href'),
    }));
    if (!isSafeClickTarget({role, name, ...info})) throw new Error('Click blocked by the safe-action policy');
    await target.click();
  }

  async fill({label, value}) {
    const page = this.requireAppPage();
    const target = page.getByLabel(label, {exact: true});
    if (await target.count() !== 1) throw new Error('Fill target must match exactly one labeled field');
    const info = await target.evaluate((element) => ({
      type: element.getAttribute('type') ?? '',
      name: element.getAttribute('name') ?? '',
      placeholder: element.getAttribute('placeholder') ?? '',
    }));
    if (isSensitiveFillTarget({label, ...info})) throw new Error('Sensitive fields must be filled manually');
    await target.fill(value);
  }

  async apiRead(path, method = 'GET') {
    if (!this.context) throw new Error('Browser is not running');
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD API reads are allowed');
    const url = validateApiPath(path);

    const started = Date.now();
    const response = await this.context.request.fetch(url.href, {
      method,
      headers: headersForUrl(url, {'Accept': 'application/json'}),
      timeout: 15_000,
      maxRedirects: 0,
    });
    const contentType = response.headers()['content-type'] ?? '';
    let body = '';
    if (method !== 'HEAD' && /^(application\/json|text\/)/i.test(contentType)) {
      body = (await response.text()).slice(0, MAX_API_BODY_CHARS);
    }
    this.pushLog({method, path: sanitizeAppPath(url), status: response.status()});

    return {
      status: response.status(),
      contentType,
      durationMs: Date.now() - started,
      body,
      truncated: body.length === MAX_API_BODY_CHARS,
    };
  }

  requireAppPage() {
    if (!this.context || !this.page) throw new Error('Browser is not running');
    if (new URL(this.page.url()).origin !== APP_ORIGIN) {
      throw new Error('Browser controls are available only on app.aikido.dev');
    }
    return this.page;
  }
}
