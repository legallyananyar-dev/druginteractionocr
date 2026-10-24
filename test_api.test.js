'use strict';
const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/check');

function run(req) {
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b, headers: this.headers }); } };
    handler(req, res);
  });
}

test('GET is rejected with 405', async () => {
  const r = await run({ method: 'GET' });
  assert.strictEqual(r.code, 405);
  assert.strictEqual(r.headers.Allow, 'POST');
});

test('too few drugs -> 400', async () => {
  const r = await run({ method: 'POST', body: { drugs: ['warfarin'] } });
  assert.strictEqual(r.code, 400);
  assert.match(r.body.error, /at least two/i);
});

test('malformed JSON string body -> 400, not 500', async () => {
  const r = await run({ method: 'POST', body: '{not json' });
  assert.strictEqual(r.code, 400);
});

test('missing body -> 400', async () => {
  const r = await run({ method: 'POST' });
  assert.strictEqual(r.code, 400);
});

test('responses are never cached', async () => {
  const r = await run({ method: 'POST', body: { drugs: [] } });
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');
});
