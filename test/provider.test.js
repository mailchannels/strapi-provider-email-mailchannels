'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const provider = require('..');

const KEY = 'synthetic-mailchannels-key-0001';
const settings = { defaultFrom: 'Acme <no-reply@acme.example>', defaultReplyTo: 'support@acme.example' };
const realFetch = globalThis.fetch;
let calls;
const respond = (status, json) => { calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(json === undefined ? null : JSON.stringify(json), { status }); }; };
afterEach(() => { globalThis.fetch = realFetch; });
const send = (options, s = settings) => provider.init({ apiKey: KEY }, s).send(options);

test('init requires an API key and sane timeout', () => {
  assert.throws(() => provider.init({}, settings), /apiKey/);
  assert.throws(() => provider.init({ apiKey: KEY, timeoutMs: 5 }, settings), /timeoutMs/);
});
test('maps a Strapi email to the Email API with defaults from settings', async () => {
  respond(202, { request_id: 'req-1', results: [{ index: 0, status: 'sent' }] });
  const res = await send({ to: 'Pat Doe <pat@example.com>, "Lee, Sam" <sam@example.com>', cc: ['cc@example.com'], bcc: { address: 'audit@acme.example' },
    subject: 'Welcome', text: 'Hello', html: '<p>Hello</p>' });
  assert.deepEqual(res, { accepted: true, requestId: 'req-1' });
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://api.mailchannels.net/tx/v1/send');
  assert.equal(init.headers['X-Api-Key'], KEY);
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(body.from, { email: 'no-reply@acme.example', name: 'Acme' });
  assert.deepEqual(body.reply_to, { email: 'support@acme.example' });
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'pat@example.com', name: 'Pat Doe' }, { email: 'sam@example.com', name: 'Lee, Sam' }],
    cc: [{ email: 'cc@example.com' }], bcc: [{ email: 'audit@acme.example' }] }]);
  assert.deepEqual(body.content.map(c => c.type), ['text/plain', 'text/html']);
});
test('explicit from and replyTo override settings', async () => {
  respond(202);
  await send({ from: 'ops@acme.example', replyTo: 'Desk <desk@acme.example>', to: 'pat@example.com', subject: 'S', text: 'T' });
  assert.deepEqual(calls[0].body.from, { email: 'ops@acme.example' });
  assert.deepEqual(calls[0].body.reply_to, { email: 'desk@acme.example', name: 'Desk' });
});
test('rejects bad input before any request', async () => {
  respond(202);
  for (const [opts, re] of [[{ to: '', subject: 'S', text: 'T' }, /to address/], [{ bcc: 'b@example.com', subject: 'S', text: 'T' }, /to address/],
    [{ to: 'not-an-address', subject: 'S', text: 'T' }, /Invalid to/], [{ to: 'a@example.com', subject: 'S\r\nBcc: x@evil.example', text: 'T' }, /single-line/],
    [{ to: 'a@example.com', subject: 'S' }, /text or html/], [{ to: 'Ev\nil <a@example.com>', subject: 'S', text: 'T' }, /Invalid to/],
    [{ to: 'a@example.com', subject: 'S', text: 'T', attachments: [{ filename: 'x', path: '/etc/passwd' }] }, /inline content/],
    [{ to: 'a@example.com', subject: 'S', text: 'T', attachments: [{ filename: 'x', href: 'http://169.254.169.254/' }] }, /inline content/]]) {
    await assert.rejects(send(opts), re);
  }
  await assert.rejects(send({ to: 'a@example.com', subject: 'S', text: 'T' }, {}), /from address/);
  assert.equal(calls.length, 0);
});
test('inline attachments are base64-encoded with a safe content type', async () => {
  respond(202);
  await send({ to: 'a@example.com', subject: 'S', text: 'T', attachments: [{ filename: 'a.txt', content: 'hi', contentType: 'text/plain' },
    { filename: 'b.bin', content: Buffer.from([1, 2]), contentType: 'bad type' }] });
  assert.deepEqual(calls[0].body.attachments, [{ filename: 'a.txt', type: 'text/plain', content: 'aGk=' }, { filename: 'b.bin', type: 'application/octet-stream', content: 'AQI=' }]);
});
test('rejections and uncertain outcomes throw once, without retry or provider body content', async () => {
  respond(400, { errors: ['bad'], echoed: 'secret body text' });
  await assert.rejects(send({ to: 'a@example.com', subject: 'S', text: 'T' }), e => e.status === 400 && !e.uncertain && !e.message.includes('secret'));
  respond(202, { results: [{ index: 0, status: 'failed' }] });
  await assert.rejects(send({ to: 'a@example.com', subject: 'S', text: 'T' }), e => !e.uncertain && /rejected/.test(e.message));
  respond(503);
  await assert.rejects(send({ to: 'a@example.com', subject: 'S', text: 'T' }), e => e.uncertain === true && e.status === 503);
  assert.equal(calls.length, 1);
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(send({ to: 'a@example.com', subject: 'S', text: 'T' }), e => e.uncertain === true && e.status === null);
});
