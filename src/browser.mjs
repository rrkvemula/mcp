import {mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {
  APP_ORIGIN,
  headersForApiUrl,
  sanitizeAppPath,
  stripResearcherHeader,
  validateApiPath,
  validateAppUrl,
} from './policy.mjs';

const MAX_LOG_ENTRIES = 200;
const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_API_BODY_CHARS = 12_000;
const BLOCKED_ACTION = /\b(delete|remove|disable|confirm|submit|send|invite|import|create|purchase|pay|checkout|logout|log out|revoke|disconnect|save|update|apply|install|start|run|launch|execute|scan|deploy|publish|authorize|grant|connect|add|continue|proceed|next|approve|accept|agree|sign|clear|reset)\b/i;
const BLOCKED_PATH_ACTION = /(?:^|\/)(delete|remove|disable|submit|send|invite|import|create|purchase|pay|checkout|revoke|disconnect|update|apply|install|start|run|execute|scan|deploy|publish|authorize|grant|connect|add|clear|reset)(?:\/|$)/i;
const SENSITIVE_FIELD = /\b(password|passcode|pin|secret|token|api\s*key|credential|cookie|authorization|otp|one\s*time|verification|security\s*code|auth\s*code|code|2fa|mfa|totp|authenticator|recovery\s*code|session|bearer|jwt)\b/i;

function normalizedFieldMetadata(values) {
  return values
    .filter((value) => typeof value === 'string' && value !== '')
    .map((value) => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase())
    .join(' ');
}

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

export function decideRequest({url, resourceType = 'other', isNavigationRequest = false, redirectedFromUrl = null, sourceUrl = null, appOrigin = APP_ORIGIN}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {action: 'abort', log: false};
  }

  if (parsed.origin === appOrigin) {
    return {action: 'continue', log: true};
  }

  if (isNavigationRequest) {
    for (const source of [redirectedFromUrl, sourceUrl]) {
      if (!source) continue;
      try {
        if (new URL(source).origin === appOrigin) {
          return {action: 'continue', log: false};
        }
      } catch {
        return {action: 'abort', log: false};
      }
    }
  }

  if (isNavigationRequest || resourceType === 'document') {
    return {action: 'abort', log: false};
  }

  return {action: 'continue', log: false};
}

export function isSafeClickTarget({role, name, type = '', href = null, formAssociated = false}) {
  if (!['button', 'link', 'tab'].includes(role) || typeof name !== 'string' || name.trim() === '') {
    return false;
  }
  if (BLOCKED_ACTION.test(name) || String(type).toLowerCase() === 'submit' || formAssociated) {
    return false;
  }

  if (role === 'link') {
    if (typeof href !== 'string' || href.trim() === '') return false;
    try {
      const target = new URL(href, APP_ORIGIN);
      if (target.origin !== APP_ORIGIN || BLOCKED_PATH_ACTION.test(target.pathname)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export function isSensitiveFillTarget({type = '', label = '', name = '', placeholder = '', id = '', autocomplete = ''}) {
  if (String(type).toLowerCase() === 'password') return true;
  const normalized = normalizedFieldMetadata([label, name, placeholder, id, autocomplete]);
  return SENSITIVE_FIELD.test(normalized);
}

export class BrowserController {
  constructor({chromiumImpl = chromium, userDataDir = path.join(os.homedir(), '.local', 'share', 'aikido-chromium-mcp', 'profile'), environment = process.env, appOrigin = APP_ORIGIN} = {}) {
    this.chromium = chromiumImpl;
    this.userDataDir = userDataDir;
    this.environment = environment;
    this.appOrigin = appOrigin;
    this.context = null;
    this.page = null;
    this.pending = new Map();
    this.entries = [];
  }

  async launch() {
    if (this.context) {
      if (this.page && !(this.page.isClosed?.() ?? false)) return;
      const page = this.context.pages()[0] ?? await this.context.newPage();
      this.attachPage(page);
      return;
    }
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

    const context = this.context;
    context.on('close', () => {
      if (this.context !== context) return;
      this.context = null;
      this.page = null;
      this.pending.clear();
    });
    this.attachPage(context.pages()[0] ?? await context.newPage());
    await this.context.route('**/*', (route) => this.routeRequest(route));
    this.context.on('response', (response) => this.recordResponse(response));
    this.context.on('requestfailed', (request) => this.recordFailure(request));
  }

  attachPage(page) {
    this.page = page;
    page.on?.('close', () => {
      if (this.page === page) this.page = null;
    });
  }

  async routeRequest(route) {
    const request = route.request();
    const previous = request.redirectedFrom();
    let sourceUrl = null;
    if (request.isNavigationRequest()) {
      try {
        const frame = request.frame();
        sourceUrl = frame.parentFrame()?.url() ?? frame.url();
        if (new URL(sourceUrl).origin !== this.appOrigin) {
          const opener = await frame.page().opener().catch(() => null);
          if (opener) sourceUrl = opener.url();
        }
      } catch {
        sourceUrl = null;
      }
      sourceUrl ??= request.headers().referer ?? null;
    }
    const decision = decideRequest({
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigationRequest: request.isNavigationRequest(),
      redirectedFromUrl: previous?.url() ?? null,
      sourceUrl,
      appOrigin: this.appOrigin,
    });

    if (decision.action === 'abort') {
      await route.abort('blockedbyclient');
      return;
    }

    const url = new URL(request.url());
    if (decision.log) {
      this.pending.set(request, {method: request.method(), path: sanitizeAppPath(url)});
    }

    // The researcher tag is applied only to explicit API probes. Keeping it
    // off browser requests avoids Chromium carrying an overridden header
    // through a cross-origin redirect that this route cannot re-intercept.
    const headers = stripResearcherHeader(request.headers());
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
    const page = this.requireOpenPage();
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
      effectiveType: element.type ?? '',
      href: element.getAttribute('href'),
      formAssociated: Boolean(element.form),
    }));
    if (!isSafeClickTarget({role, name, type: info.effectiveType || info.type, href: info.href, formAssociated: info.formAssociated})) throw new Error('Click blocked by the safe-action policy');
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
      id: element.id ?? element.getAttribute('id') ?? '',
      autocomplete: element.getAttribute('autocomplete') ?? '',
    }));
    if (isSensitiveFillTarget({label, ...info})) throw new Error('Sensitive fields must be filled manually');
    await target.fill(value);
  }

  async apiRead(path, method = 'GET') {
    if (!this.context) throw new Error('Browser is not running');
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD API reads are allowed');
    const url = validateApiPath(path);

    const started = Date.now();
    try {
      const response = await this.context.request.fetch(url.href, {
        method,
        headers: headersForApiUrl(url, {'Accept': 'application/json'}),
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
    } catch {
      throw new Error('API read failed; request details were redacted.');
    }
  }

  requireOpenPage() {
    if (!this.context || !this.page) throw new Error('Browser is not running');
    return this.page;
  }

  requireAppPage() {
    if (!this.context || !this.page) throw new Error('Browser is not running');
    if (new URL(this.page.url()).origin !== this.appOrigin) {
      throw new Error('Browser controls are available only on app.aikido.dev');
    }
    return this.page;
  }
}
