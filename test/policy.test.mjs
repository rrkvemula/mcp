import assert from 'node:assert/strict';
import test from 'node:test';

const policy = await import('../src/policy.mjs').catch(() => null);

function getPolicy() {
  assert.ok(policy, 'policy module is not implemented');
  return policy;
}

test('accepts only clean HTTPS page URLs on the in-scope app host', () => {
  const {validateAppUrl} = getPolicy();

  assert.equal(validateAppUrl('https://app.aikido.dev/').href, 'https://app.aikido.dev/');
  for (const value of [
    'http://app.aikido.dev/',
    'https://app.aikido.dev.evil.test/',
    'https://cdn.aikido.dev/',
    'https://user@app.aikido.dev/',
    'https://app.aikido.dev/?redirect=https://evil.test',
    'https://app.aikido.dev/#token',
  ]) {
    assert.throws(() => validateAppUrl(value), `should reject ${value}`);
  }
});

test('accepts only relative API paths on the app origin', () => {
  const {validateApiPath} = getPolicy();

  assert.equal(
    validateApiPath('/api/issues/list?status=open').href,
    'https://app.aikido.dev/api/issues/list?status=open',
  );
  for (const value of [
    'https://evil.test/api/issues',
    '//evil.test/api/issues',
    '/account/profile',
    '/api/../account/profile',
    '/api/issues#secret',
  ]) {
    assert.throws(() => validateApiPath(value), `should reject ${value}`);
  }
});

test('adds the researcher header only to explicit API requests for the exact app origin', () => {
  const {headersForApiUrl} = getPolicy();
  const base = {'Accept': 'application/json', 'x-intigriti': 'wrong-value'};

  assert.deepEqual(
    headersForApiUrl(new URL('https://app.aikido.dev/api/issues'), base),
    {'Accept': 'application/json', 'X-Intigriti': 'rkvemula'},
  );
  assert.deepEqual(
    headersForApiUrl(new URL('https://cdn.aikido.dev/assets/app.js'), base),
    {'Accept': 'application/json'},
  );
});

test('sanitizes query, fragment, and UUID path values from app request logs', () => {
  const {sanitizeAppPath} = getPolicy();
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

  assert.equal(
    sanitizeAppPath(new URL(`https://app.aikido.dev/api/teams/${id}/issues?token=private#tab`)),
    '/api/teams/{id}/issues',
  );
  assert.equal(
    sanitizeAppPath(new URL(`https://app.aikido.dev/api/reset/${token}?next=/dashboard`)),
    '/api/reset/{id}',
  );
  assert.equal(
    sanitizeAppPath(new URL('https://app.aikido.dev/api/issues/1234567890123')),
    '/api/issues/{id}',
  );
});

test('enforces a rolling five-probe-per-minute budget', () => {
  const {ProbeBudget} = getPolicy();
  let now = 1000;
  const budget = new ProbeBudget(5, 60_000, () => now);

  for (let i = 0; i < 5; i += 1) budget.consume();
  assert.throws(() => budget.consume(), /rate limit/i);
  now += 60_000;
  assert.doesNotThrow(() => budget.consume());
});
