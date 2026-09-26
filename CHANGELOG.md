# Changelog

## 0.2.0

- New `forUser(userId, attributes)` for servers handling many users; assignments are cached per user.
- New `serverSecret` option and `createUserToken(userId)` to mint user tokens for your apps.
- Fixed server-side assignment and event sync.
