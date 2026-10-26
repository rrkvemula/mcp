export const APP_ORIGIN = 'https://app.aikido.dev';
export const RESEARCHER_HEADER = 'X-Intigriti';
export const RESEARCHER_USERNAME = 'rkvemula';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_NUMERIC_SEGMENT = /^\d{6,}$/;
const LONG_HEX_SEGMENT = /^[0-9a-f]{24,}$/i;
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;
const SENSITIVE_PATH_LABEL = /^(token|secret|key|credential|authorization|session|reset|invite|code|state)$/i;

export function validateAppUrl(value) {
  if (typeof value !== 'string') {
    throw new TypeError('App URL must be a string');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('App URL must be an absolute HTTPS URL');
  }

  if (
    url.protocol !== 'https:'
    || url.origin !== APP_ORIGIN
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('Only clean HTTPS URLs on app.aikido.dev may be navigated');
  }

  return url;
}

export function validateApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//')) {
    throw new TypeError('API path must be app-relative and begin with /api/');
  }

  let url;
  try {
    url = new URL(path, APP_ORIGIN);
  } catch {
    throw new TypeError('API path is invalid');
  }

  if (
    url.origin !== APP_ORIGIN
    || !url.pathname.startsWith('/api/')
    || url.hash !== ''
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error('API path must stay on app.aikido.dev under /api/');
  }

  return url;
}

export function headersForApiUrl(url, baseHeaders = {}) {
  const headers = Object.fromEntries(
    Object.entries(baseHeaders).filter(([name]) => name.toLowerCase() !== RESEARCHER_HEADER.toLowerCase()),
  );

  if (url instanceof URL && url.origin === APP_ORIGIN) {
    headers[RESEARCHER_HEADER] = RESEARCHER_USERNAME;
  }

  return headers;
}

export function stripResearcherHeader(baseHeaders = {}) {
  return Object.fromEntries(
    Object.entries(baseHeaders).filter(([name]) => name.toLowerCase() !== RESEARCHER_HEADER.toLowerCase()),
  );
}

export function sanitizeAppPath(url) {
  if (!(url instanceof URL)) {
    throw new TypeError('sanitizeAppPath expects a URL');
  }

  let redactNext = false;
  return url.pathname.split('/').map((segment) => {
    if (redactNext) {
      redactNext = false;
      return '{id}';
    }
    if (SENSITIVE_PATH_LABEL.test(segment)) {
      redactNext = true;
      return segment;
    }
    if (
      UUID_SEGMENT.test(segment)
      || LONG_NUMERIC_SEGMENT.test(segment)
      || LONG_HEX_SEGMENT.test(segment)
      || TOKEN_LIKE_SEGMENT.test(segment)
      || segment.includes('@')
      || /%40/i.test(segment)
    ) {
      return '{id}';
    }
    return segment;
  }).join('/');
}

export class ProbeBudget {
  constructor(limit = 5, windowMs = 60_000, now = Date.now) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('Probe limit must be a positive integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError('Probe window must be positive');
    }

    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.timestamps = [];
  }

  consume() {
    const current = this.now();
    this.timestamps = this.timestamps.filter((timestamp) => current - timestamp < this.windowMs);
    if (this.timestamps.length >= this.limit) {
      throw new Error(`API probe rate limit: maximum ${this.limit} per ${this.windowMs}ms`);
    }
    this.timestamps.push(current);
  }
}
