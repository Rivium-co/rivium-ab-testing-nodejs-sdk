# Changelog

## 0.2.3

- Follows the list cache set in the Rivium console: the experiment list is asked for again once it is older than the console allows.
- A `flushInterval` you pass now wins over the console's send interval; leave it out to follow the console. Changes apply without a restart.
- Sends each event's own time as milliseconds.

## 0.2.2

- `init()` warns when `serverSecret` is missing.
- Variants are decided by the service only; without an answer `getVariant` returns the cached assignment or your default.
- Events the service refuses are kept (at most 1,000) and reported once through the `error` event; batches back off when the service is busy.
- Requires Node.js 18 or newer.

## 0.2.0

- New `forUser(userId, attributes)` for servers handling many users; assignments are cached per user.
- New `serverSecret` option and `createUserToken(userId)` to mint user tokens for your apps.
- Fixed server-side assignment and event sync.
