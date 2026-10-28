'use strict';

const ENDPOINT = 'https://api.mailchannels.net/tx/v1/send';
const EMAIL = /^[^\s<>@,;"\x00-\x1f\x7f]+@[^\s<>@,;"\x00-\x1f\x7f]+\.[^\s<>@,;"\x00-\x1f\x7f]+$/;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

class MailChannelsEmailError extends Error {
  /** `uncertain` means MailChannels may have accepted the message: do not resend automatically. */
  constructor(message, { status = null, uncertain = false, requestId = null } = {}) {
    super(message); this.name = 'MailChannelsEmailError'; this.status = status; this.uncertain = uncertain; this.requestId = requestId;
  }
}
const invalid = message => { throw new MailChannelsEmailError(message); };

/** Accepts "a@b.c", "Name <a@b.c>", comma-separated strings, arrays, or {address|email, name} objects. */
function addresses(value, field) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.match(/(?:"[^"]*"|[^,])+/g) ?? [] : [value];
  return items.map(item => {
    if (item && typeof item === 'object') {
      const email = item.address ?? item.email;
      if (typeof email !== 'string' || !EMAIL.test(email)) invalid(`Invalid ${field} address.`);
      return item.name ? { email, name: name(item.name, field) } : { email };
    }
    const s = String(item).trim();
    const m = /^(?:"?([^"<>]*?)"?\s*<([^<>\s]+)>|([^<>\s]+))$/.exec(s);
    const email = m && (m[2] ?? m[3]);
    if (!email || !EMAIL.test(email)) invalid(`Invalid ${field} address.`);
    return m[1]?.trim() ? { email, name: name(m[1].trim(), field) } : { email };
  });
}
function name(value, field) {
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f"<>]/.test(value)) invalid(`Invalid ${field} display name.`);
  return value;
}
function attachment(a) {
  if (!a || typeof a !== 'object' || a.path !== undefined || a.href !== undefined) invalid('Attachments must provide inline content; path and URL attachments are not supported.');
  if (typeof a.filename !== 'string' || !a.filename || a.filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(a.filename)) invalid('Invalid attachment filename.');
  const bytes = Buffer.isBuffer(a.content) ? a.content : typeof a.content === 'string' ? Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8') : null;
  if (!bytes || bytes.length > MAX_ATTACHMENT_BYTES) invalid('Attachment content is missing or too large.');
  const type = typeof a.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType) ? a.contentType : 'application/octet-stream';
  return { filename: a.filename, type, content: bytes.toString('base64') };
}

module.exports = {
  init(providerOptions = {}, settings = {}) {
    const { apiKey, timeoutMs = 15000 } = providerOptions;
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(apiKey)) throw new Error('MailChannels provider: providerOptions.apiKey is required.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('MailChannels provider: timeoutMs must be 100-60000.');

    return {
      async send(options = {}) {
        const [from] = addresses(options.from ?? settings.defaultFrom, 'from');
        if (!from) invalid('A from address is required (options.from or settings.defaultFrom).');
        const to = addresses(options.to, 'to'), cc = addresses(options.cc, 'cc'), bcc = addresses(options.bcc, 'bcc');
        const [replyTo] = addresses(options.replyTo ?? settings.defaultReplyTo, 'replyTo');
        if (!to.length) invalid('At least one to address is required.');
        if (to.length + cc.length + bcc.length > 1000) invalid('Too many recipients.');
        if (typeof options.subject !== 'string' || !options.subject.trim() || /[\r\n]/.test(options.subject)) invalid('A single-line subject is required.');
        const content = [];
        if (typeof options.text === 'string' && options.text) content.push({ type: 'text/plain', value: options.text });
        if (typeof options.html === 'string' && options.html) content.push({ type: 'text/html', value: options.html });
        if (!content.length) invalid('Either text or html is required.');
        const personalization = { to };
        if (cc.length) personalization.cc = cc;
        if (bcc.length) personalization.bcc = bcc;
        const body = { from, personalizations: [personalization], subject: options.subject, content };
        if (replyTo) body.reply_to = replyTo;
        if (Array.isArray(options.attachments) && options.attachments.length) body.attachments = options.attachments.map(attachment);

        let response;
        try {
          response = await fetch(ENDPOINT, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
            headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch {
          throw new MailChannelsEmailError('MailChannels request failed before a response; the email may have been accepted. Not retried.', { uncertain: true });
        }
        let parsed = null;
        try { const raw = await response.text(); parsed = raw ? JSON.parse(raw) : null; } catch { parsed = undefined; }
        const requestId = typeof parsed?.request_id === 'string' ? parsed.request_id.slice(0, 256) : null;
        if (response.status === 202) {
          const failed = Array.isArray(parsed?.results) && parsed.results.some(r => r?.status === 'failed');
          if (failed) throw new MailChannelsEmailError('MailChannels rejected one or more recipients.', { status: 202, requestId });
          return { accepted: true, requestId };
        }
        // Never include the provider response body: it can echo message content.
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          throw new MailChannelsEmailError(`MailChannels rejected the email (HTTP ${response.status}).`, { status: response.status, requestId });
        }
        throw new MailChannelsEmailError(`MailChannels returned HTTP ${response.status}; the email may have been accepted. Not retried.`,
          { status: response.status, uncertain: true, requestId });
      }
    };
  },
  MailChannelsEmailError
};
