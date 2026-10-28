# strapi-provider-email-mailchannels

A [Strapi](https://strapi.io) email provider that sends through the MailChannels Email API (`POST https://api.mailchannels.net/tx/v1/send`). It has no dependencies and works on Node 20 or later with the global `fetch`.

## Install

```sh
npm install strapi-provider-email-mailchannels
```

## Configure

`config/plugins.js`:

```js
module.exports = ({ env }) => ({
  email: {
    config: {
      provider: 'strapi-provider-email-mailchannels',
      providerOptions: { apiKey: env('MAILCHANNELS_API_KEY') },
      settings: {
        defaultFrom: 'Acme <no-reply@acme.example>',
        defaultReplyTo: 'support@acme.example',
      },
    },
  },
});
```

Keep the API key in your deployment's secret store. The sender domain must be authorized for your MailChannels account, including its Domain Lockdown record.

## Behavior

- **Address fields.** `to`, `cc`, `bcc` and `replyTo` each accept any of:
  - an address like `a@b.c`,
  - `Name <a@b.c>`,
  - a comma-separated list (quoted names may contain commas),
  - an array of the above,
  - `{ address | email, name }` objects.
- **Defaults.** `from` and `replyTo` fall back to `settings.defaultFrom` and `settings.defaultReplyTo`.
- **Input checks.** At least one `to` address is required. A message with only Bcc recipients is refused. The subject must be a single line, so header injection is refused. At least one of `text` or `html` is required. Plain text is sent before HTML.
- **Attachments.** Only inline `content` (a Buffer or string; use `encoding: 'base64'` for base64 strings) is accepted, up to 10 MiB each. `path` and `href` attachments are refused rather than fetched.
- **Results.** On acceptance, `send` resolves to `{ accepted: true, requestId }`. Acceptance is not delivery.
- **Errors.** Failures throw a `MailChannelsEmailError` with `status` and `uncertain` fields:
  - `uncertain: false` (4xx, or a per-recipient `failed`): MailChannels refused the email.
  - `uncertain: true` (5xx, timeout or network failure): the email may have been accepted. The provider **never retries**, so a caller that retries could send a duplicate.
  - Error messages never include the API key or the provider's response body.

## Reporting issues

Report bugs in this repository's [issue tracker](https://github.com/mailchannels/strapi-provider-email-mailchannels/issues). For account questions, contact MailChannels support at <https://support.mailchannels.com/>. Never include your API key.

## License

MIT. See `LICENSE`.

## Validation

```sh
npm test
```

The 6 tests use a mocked `fetch` and cover:
- request mapping and the defaults from `settings`;
- override precedence;
- input rejection, including header injection and `path`/URL attachments;
- inline attachments;
- rejected and uncertain outcomes, which never retry or leak the response body.

Negative controls: allowing `path` attachments fails the input test, and treating 503 as accepted fails the outcome test.

Native Strapi check (2026-10-10): a Strapi 5.57.0 app was booted with this package configured exactly as above and a local Email API mock (Docker `--network none`). All 10 tests pass:
- Strapi resolves the provider;
- `send` and `sendTemplatedEmail` map defaults, recipients and content;
- a 400, a 5xx and a per-recipient failure inside a 202 each surface once, correctly marked rejected or uncertain, with no retry and no response body;
- a Bcc-only message is refused;
- the Users & Permissions password reset and the admin test-email controller send through it;
- the admin settings response hides the key.

Forcing the fixture back to the Nodemailer composition fails 5 of them.

The provider has not yet been exercised against the live Email API.
