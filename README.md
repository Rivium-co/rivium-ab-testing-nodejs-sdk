# Rivium AB Testing Node.js SDK

Server-side A/B Testing and Feature Flags SDK for Node.js.

[![npm](https://img.shields.io/npm/v/rivium-ab-testing-node.svg)](https://www.npmjs.com/package/rivium-ab-testing-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Server-side A/B testing with deterministic variant assignment
- Feature flags with targeting rules and rollout percentages
- Sticky bucketing — users stay in the same variant
- Event queue with automatic batch sync
- 17 built-in event types (view, click, conversion, purchase, etc.)
- Dual CJS/ESM output with full TypeScript types
- Node.js 16+

## Installation

```bash
npm install rivium-ab-testing-node
```

## Quick Start

```typescript
import { RiviumAbTesting } from 'rivium-ab-testing-node';

// 1. Initialize once, when your server starts
await RiviumAbTesting.init({
  apiKey: 'rv_live_your_api_key',
  serverSecret: process.env.RIVIUM_SERVER_SECRET, // from Rivium Console; server only
});

// 2. In a request handler: one handle per user
app.get('/checkout', async (req, res) => {
  const user = RiviumAbTesting.forUser(req.user.id, { plan: req.user.plan });

  const variant = await user.getVariant('checkout-redesign');
  // ...render the page for that variant...

  await user.trackConversion('checkout-redesign', 49.99);
});

// 3. On shutdown: send what is still queued
await RiviumAbTesting.destroy();
```

## Many users on one server

A server answers many users at once. Always go through `forUser(userId)`:
each handle carries its own user, and assignments are cached per user and
experiment, so one user's variant is never served to another.

`setUserId()` still works for scripts and single-user processes, but on a
server two requests would overwrite each other's user. Don't use it there.

## Server secret and user tokens

This SDK runs on your server, so it can prove that with your project's
**server secret** (`serverSecret` in `init`). The service then trusts the user
ids you pass, even when your project requires signed user tokens.

Your apps can't hold the secret. They send a short-lived **user token** that
your server mints for the signed-in user:

```typescript
app.post('/rivium-token', requireLogin, async (req, res) => {
  res.json(await RiviumAbTesting.createUserToken(req.session.userId));
});
```

Give the app SDK a `tokenProvider` that calls this endpoint. The same token
works for Rivium Chat and Sync.

**Never put the server secret in an app, a browser bundle, or a public repo.**

## A/B Testing

The examples below use `user = RiviumAbTesting.forUser(userId)`.

### Get Variant

```typescript
const variant = await user.getVariant(
  'experiment-key',
  'control' // fallback if offline and no cache
);
```

### Get Variant Config

```typescript
const config = await user.getVariantConfig('experiment-key');
const layout = config?.layout;
const buttonColor = config?.button_color;
```

### List Experiments

```typescript
const experiments = RiviumAbTesting.getExperiments();
experiments.forEach((exp) => {
  console.log(`${exp.key} [${exp.status}] - ${exp.variants.length} variants`);
});

// Refresh from server
await RiviumAbTesting.refreshExperiments();
```

## Feature Flags

```typescript
// Check if feature is enabled
const darkMode = await user.isFeatureEnabled('dark-mode');

// Get feature value (string, number, JSON, etc.)
const maxUpload = await user.getFeatureValue('max-upload-size', 10);

// Get all flags
const flags = await RiviumAbTesting.getFeatureFlags();
flags.forEach((flag) => {
  console.log(`${flag.key}: enabled=${flag.enabled}, rollout=${flag.rolloutPercentage}%`);
});

// Refresh flags from server
await RiviumAbTesting.refreshFeatureFlags();
```

## Event Tracking

Track user interactions with 17 built-in event types:

```typescript
// Core events
await user.trackView('experiment-key');
await user.trackClick('experiment-key');
await user.trackConversion('experiment-key', 99.99);

// Custom event
await user.trackCustomEvent('experiment-key', 'button_hover', {
  duration_ms: 1500,
  element: 'cta_button',
});

// E-commerce events
await user.trackAddToCart('experiment-key', 29.99, 'sku-123', { quantity: 2 });
await user.trackPurchase('experiment-key', 59.99, 'txn-456', { currency: 'USD' });
await user.trackRemoveFromCart('experiment-key', 29.99, 'sku-123');
await user.trackBeginCheckout('experiment-key', 59.99);

// Engagement events
await user.trackScroll('experiment-key', 75.0);
await user.trackFormSubmit('experiment-key', 'signup');
await user.trackSearch('experiment-key', 'shoes');
await user.trackShare('experiment-key', 'twitter');

// Media events
await user.trackVideoStart('experiment-key', 'vid-001');
await user.trackVideoComplete('experiment-key', 'vid-001');

// Auth events
await user.trackSignUp('experiment-key', 'google');
await user.trackLogin('experiment-key', 'email');
await user.trackLogout('experiment-key');
```

### Generic Event Tracking

```typescript
import { EventType } from 'rivium-ab-testing-node';

await user.trackEvent(
  'experiment-key',
  EventType.CUSTOM,
  'page_load_time',
  2.3,
  { page: '/checkout', cached: false }
);
```

## User Attributes

Pass attributes for targeting rules with the user:

```typescript
const user = RiviumAbTesting.forUser('user-123', {
  plan: 'premium',
  country: 'US',
  age: 28,
});
```

## Event Listeners

```typescript
// Listen for SDK events
RiviumAbTesting.on('experimentAssigned', (event) => {
  console.log('Assigned:', event.data);
});

// Available events:
// 'initialized', 'error', 'experimentAssigned', 'experimentsRefreshed',
// 'featureFlagsRefreshed', 'syncCompleted'

// Unsubscribe
RiviumAbTesting.off('experimentAssigned', callback);
```

## Configuration

```typescript
await RiviumAbTesting.init({
  apiKey: 'rv_live_your_api_key',
  serverSecret: process.env.RIVIUM_SERVER_SECRET, // optional; required for createUserToken
  debug: false,                // log to the console (development only)
  flushInterval: 30000,        // send queued events every N ms (default: 30000)
  maxQueueSize: 1000,          // events kept while waiting to send (default: 1000)
  maxCachedAssignments: 10000, // (user, experiment) assignments kept in memory (default: 10000)
});
```

## Lifecycle

```typescript
// Refresh experiments from server
await RiviumAbTesting.refreshExperiments();

// Send pending events now
await RiviumAbTesting.flush();

// Send pending events and stop timers
await RiviumAbTesting.destroy();
```

## API Reference

| Method | Description |
|---|---|
| `init(config)` | Initialize the SDK |
| `forUser(id, attrs?)` | A handle acting for one user (use per request) |
| `createUserToken(id)` | Mint a user token for your app (needs `serverSecret`) |
| `setUserId(id)` | Single-user processes only: set the SDK's own user |
| `getUserId()` | Get the SDK's own user ID |
| `setUserAttributes(attrs)` | Single-user processes only: targeting attributes |
| `getVariant(key)` | Get assigned variant |
| `getVariantConfig(key)` | Get variant configuration |
| `isFeatureEnabled(key)` | Check if feature flag is on |
| `getFeatureValue(key)` | Get feature flag value |
| `getFeatureFlags()` | Get all feature flags |
| `refreshFeatureFlags()` | Refresh flags from server |
| `refreshExperiments()` | Refresh experiments from server |
| `getExperiments()` | Get all experiments |
| `trackEvent(key, type, ...)` | Track generic event |
| `flush()` | Force sync pending events |
| `destroy()` | Flush + cleanup timers |
| `on(event, callback)` | Subscribe to SDK events |
| `off(event, callback)` | Unsubscribe from events |

### Event Types

| Type | Constant |
|---|---|
| View | `EventType.VIEW` |
| Click | `EventType.CLICK` |
| Conversion | `EventType.CONVERSION` |
| Custom | `EventType.CUSTOM` |
| Scroll | `EventType.SCROLL` |
| Form Submit | `EventType.FORM_SUBMIT` |
| Search | `EventType.SEARCH` |
| Share | `EventType.SHARE` |
| Add to Cart | `EventType.ADD_TO_CART` |
| Remove from Cart | `EventType.REMOVE_FROM_CART` |
| Begin Checkout | `EventType.BEGIN_CHECKOUT` |
| Purchase | `EventType.PURCHASE` |
| Video Start | `EventType.VIDEO_START` |
| Video Complete | `EventType.VIDEO_COMPLETE` |
| Sign Up | `EventType.SIGN_UP` |
| Login | `EventType.LOGIN` |
| Logout | `EventType.LOGOUT` |

## Documentation

- [Rivium Console](https://console.rivium.co)
- [Node.js SDK Docs](https://console.rivium.co/dashboard/rivium-abtest/docs/nodejs)

## License

MIT
