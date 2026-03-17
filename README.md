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
import { RiviumAbTestingSDK } from 'rivium-ab-testing-node';

const sdk = new RiviumAbTestingSDK();

// 1. Initialize
await sdk.init({
  apiKey: 'rv_live_your_api_key',
  debug: true,
});

// 2. Set user
sdk.setUserId('user-123');

// 3. Get variant
const variant = await sdk.getVariant('checkout-redesign');

// 4. Track conversion
await sdk.trackConversion('checkout-redesign', 49.99);

// 5. Flush events
await sdk.flush();

// 6. Cleanup
await sdk.destroy();
```

## A/B Testing

### Get Variant

```typescript
const variant = await sdk.getVariant(
  'experiment-key',
  'control' // fallback if offline and no cache
);
```

### Get Variant Config

```typescript
const config = await sdk.getVariantConfig('experiment-key');
const layout = config?.layout;
const buttonColor = config?.button_color;
```

### List Experiments

```typescript
const experiments = sdk.getExperiments();
experiments.forEach((exp) => {
  console.log(`${exp.key} [${exp.status}] - ${exp.variants.length} variants`);
});

// Refresh from server
await sdk.refreshExperiments();
```

## Feature Flags

```typescript
// Check if feature is enabled
const darkMode = await sdk.isFeatureEnabled('dark-mode');

// Get feature value (string, number, JSON, etc.)
const maxUpload = await sdk.getFeatureValue('max-upload-size', 10);

// Get all flags
const flags = await sdk.getFeatureFlags();
flags.forEach((flag) => {
  console.log(`${flag.key}: enabled=${flag.enabled}, rollout=${flag.rolloutPercentage}%`);
});

// Refresh flags from server
await sdk.refreshFeatureFlags();
```

## Event Tracking

Track user interactions with 17 built-in event types:

```typescript
// Core events
await sdk.trackView('experiment-key');
await sdk.trackClick('experiment-key');
await sdk.trackConversion('experiment-key', 99.99);

// Custom event
await sdk.trackCustomEvent('experiment-key', 'button_hover', {
  duration_ms: 1500,
  element: 'cta_button',
});

// E-commerce events
await sdk.trackAddToCart('experiment-key', 29.99, 'sku-123', { quantity: 2 });
await sdk.trackPurchase('experiment-key', 59.99, 'txn-456', { currency: 'USD' });
await sdk.trackRemoveFromCart('experiment-key', 29.99, 'sku-123');
await sdk.trackBeginCheckout('experiment-key', 59.99);

// Engagement events
await sdk.trackScroll('experiment-key', 75.0);
await sdk.trackFormSubmit('experiment-key', 'signup');
await sdk.trackSearch('experiment-key', 'shoes');
await sdk.trackShare('experiment-key', 'twitter');

// Media events
await sdk.trackVideoStart('experiment-key', 'vid-001');
await sdk.trackVideoComplete('experiment-key', 'vid-001');

// Auth events
await sdk.trackSignUp('experiment-key', 'google');
await sdk.trackLogin('experiment-key', 'email');
await sdk.trackLogout('experiment-key');
```

### Generic Event Tracking

```typescript
import { EventType } from 'rivium-ab-testing-node';

await sdk.trackEvent(
  'experiment-key',
  EventType.CUSTOM,
  'page_load_time',
  2.3,
  { page: '/checkout', cached: false }
);
```

## User Attributes

Set attributes for targeting rules:

```typescript
sdk.setUserId('user-123');

sdk.setUserAttributes({
  plan: 'premium',
  country: 'US',
  age: 28,
  platform: 'node',
});
```

## Event Listeners

```typescript
// Listen for SDK events
sdk.on('experimentAssigned', (event) => {
  console.log('Assigned:', event.data);
});

// Available events:
// 'initialized', 'error', 'experimentAssigned', 'experimentsRefreshed',
// 'featureFlagsRefreshed', 'syncCompleted'

// Unsubscribe
sdk.off('experimentAssigned', callback);
```

## Configuration

```typescript
await sdk.init({
  apiKey: 'rv_live_your_api_key',
  debug: true,            // Enable debug logging
  flushInterval: 30000,   // Auto-flush interval in ms (default: 30000)
  maxQueueSize: 100,      // Max events before auto-flush (default: 100)
});
```

## Lifecycle

```typescript
// Refresh experiments from server
await sdk.refreshExperiments();

// Flush pending events
await sdk.flush();

// Destroy SDK (flush + cleanup timers)
await sdk.destroy();
```

## API Reference

| Method | Description |
|---|---|
| `init(config)` | Initialize the SDK |
| `setUserId(id)` | Set user ID for assignment |
| `getUserId()` | Get current user ID |
| `setUserAttributes(attrs)` | Set targeting attributes |
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
