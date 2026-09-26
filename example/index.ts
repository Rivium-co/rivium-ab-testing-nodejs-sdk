import { RiviumAbTestingSDK, EventType } from 'rivium-ab-testing-node';

const API_KEY = 'YOUR_API_KEY_HERE';
const TEST_USER_ID = 'test-user-node-001';
const TEST_EXPERIMENT_KEY = 'checkout-flow-test';
const FLAG_KEYS = ['dark_mode', 'Onboarding Flow', 'Dark Mode Settings', 'maintenance_mode', 'premium_banner', 'checkout_flow'];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(section: string, message: string) {
  console.log(`[${section}] ${message}`);
}

async function main() {
  const sdk = new RiviumAbTestingSDK();

  // ── Event Listeners ──
  sdk.on('initialized', () => log('Event', 'SDK initialized'));
  sdk.on('experimentAssigned', (e) =>
    log('Event', `Experiment assigned: ${JSON.stringify(e.data)}`)
  );
  sdk.on('experimentsRefreshed', (e) =>
    log('Event', `Experiments refreshed: ${JSON.stringify(e.data)}`)
  );
  sdk.on('featureFlagsRefreshed', () =>
    log('Event', 'Feature flags refreshed')
  );
  sdk.on('syncCompleted', (e) =>
    log('Event', `Sync completed: ${JSON.stringify(e.data)}`)
  );
  sdk.on('error', (e) => log('Event', `Error: ${JSON.stringify(e.data)}`));

  // ── Initialize ──
  log('Init', 'Initializing SDK...');
  await sdk.init({
    apiKey: API_KEY,
    // Your project's server secret: this runs on your server. Never ship it in an app.
    serverSecret: process.env.RIVIUM_SERVER_SECRET,
    debug: true,
    flushInterval: 10000,
    maxQueueSize: 50,
  });
  log('Init', 'SDK initialized');

  await delay(500);

  // ── User ──
  // One handle per user. On a web server, make one per request with that
  // request's user: users never see each other's variants.
  log('User', `Acting for user: ${TEST_USER_ID}`);
  const user = sdk.forUser(TEST_USER_ID, {
    plan: 'premium',
    country: 'US',
    app_version: '1.0.0',
    platform: 'node',
  });
  log('User', `User ID: ${user.userId}`);

  await delay(300);

  // ── Experiments ──
  log('Experiments', 'Getting variant...');
  const variant = await user.getVariant(TEST_EXPERIMENT_KEY, 'control');
  log('Experiments', `Variant for '${TEST_EXPERIMENT_KEY}': ${variant}`);

  const config = await user.getVariantConfig(TEST_EXPERIMENT_KEY);
  log('Experiments', `Variant config: ${JSON.stringify(config)}`);

  const experiments = sdk.getExperiments();
  log('Experiments', `Total experiments: ${experiments.length}`);

  await delay(300);

  // ── Core Events ──
  log('Events', 'Tracking core events...');
  await user.trackView(TEST_EXPERIMENT_KEY);
  log('Events', 'Tracked: view');

  await user.trackClick(TEST_EXPERIMENT_KEY);
  log('Events', 'Tracked: click');

  await user.trackConversion(TEST_EXPERIMENT_KEY, 29.99);
  log('Events', 'Tracked: conversion ($29.99)');

  await user.trackCustomEvent(TEST_EXPERIMENT_KEY, 'button_hover', {
    element: 'cta-primary',
    duration_ms: 1500,
  });
  log('Events', 'Tracked: custom (button_hover)');

  await delay(300);

  // ── Engagement Events ──
  log('Engagement', 'Tracking engagement events...');
  await user.trackScroll(TEST_EXPERIMENT_KEY, 75, { section: 'pricing' });
  log('Engagement', 'Tracked: scroll (75%)');

  await user.trackFormSubmit(TEST_EXPERIMENT_KEY, 'checkout_form', {
    fields: 5,
  });
  log('Engagement', 'Tracked: form_submit (checkout_form)');

  await user.trackSearch(TEST_EXPERIMENT_KEY, 'node sdk', { results: 12 });
  log('Engagement', 'Tracked: search (node sdk)');

  await user.trackShare(TEST_EXPERIMENT_KEY, 'twitter', { content: 'product' });
  log('Engagement', 'Tracked: share (twitter)');

  await delay(300);

  // ── E-Commerce Events ──
  log('E-Commerce', 'Tracking e-commerce events...');
  await user.trackAddToCart(TEST_EXPERIMENT_KEY, 49.99, 'prod-456', {
    category: 'electronics',
  });
  log('E-Commerce', 'Tracked: add_to_cart ($49.99)');

  await user.trackRemoveFromCart(TEST_EXPERIMENT_KEY, 49.99, 'prod-456');
  log('E-Commerce', 'Tracked: remove_from_cart');

  await user.trackBeginCheckout(TEST_EXPERIMENT_KEY, 149.97, { items: 3 });
  log('E-Commerce', 'Tracked: begin_checkout ($149.97)');

  await user.trackPurchase(TEST_EXPERIMENT_KEY, 134.97, 'txn-789', {
    currency: 'USD',
    items: 3,
  });
  log('E-Commerce', 'Tracked: purchase ($134.97)');

  await delay(300);

  // ── Media Events ──
  log('Media', 'Tracking media events...');
  await user.trackVideoStart(TEST_EXPERIMENT_KEY, 'video-onboarding-01');
  log('Media', 'Tracked: video_start');

  await user.trackVideoComplete(TEST_EXPERIMENT_KEY, 'video-onboarding-01');
  log('Media', 'Tracked: video_complete');

  await delay(300);

  // ── Auth Events ──
  log('Auth', 'Tracking auth events...');
  await user.trackSignUp(TEST_EXPERIMENT_KEY, 'google');
  log('Auth', 'Tracked: sign_up (google)');

  await user.trackLogin(TEST_EXPERIMENT_KEY, 'email');
  log('Auth', 'Tracked: login (email)');

  await user.trackLogout(TEST_EXPERIMENT_KEY);
  log('Auth', 'Tracked: logout');

  await delay(300);

  // ── Generic Event ──
  log('Generic', 'Tracking generic event...');
  await user.trackEvent(TEST_EXPERIMENT_KEY, EventType.CUSTOM, 'page_load', 1.5, {
    route: '/dashboard',
    load_time_ms: 1500,
  });
  log('Generic', 'Tracked: custom page_load event');

  await delay(300);

  // ── Feature Flags ──
  log('Flags', 'Testing feature flags...');
  for (const key of FLAG_KEYS) {
    const enabled = await user.isFeatureEnabled(key);
    log('Flags', `Flag '${key}': ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  const darkModeValue = await user.getFeatureValue('Dark Mode Settings', 'default');
  log('Flags', `Feature value 'Dark Mode Settings': ${JSON.stringify(darkModeValue)}`);

  const allFlags = await sdk.getFeatureFlags();
  log('Flags', `Total feature flags: ${allFlags.length}`);

  await sdk.refreshFeatureFlags();
  log('Flags', 'Feature flags refreshed');

  await delay(300);

  // ── Lifecycle ──
  log('Lifecycle', 'Flushing events...');
  await sdk.flush();
  log('Lifecycle', 'Events flushed');

  log('Lifecycle', 'Refreshing experiments...');
  await sdk.refreshExperiments();
  log('Lifecycle', 'Experiments refreshed');

  await delay(500);

  // ── Cleanup ──
  log('Cleanup', 'Destroying SDK...');
  await sdk.destroy();
  log('Cleanup', 'SDK destroyed');

  console.log('\n✅ All tests completed successfully!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
