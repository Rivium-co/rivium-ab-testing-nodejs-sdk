import { RiviumAbTestingSDK } from '../index';
import { FakeService, assigned, unauthorized, settle } from './helpers';

const EXPERIMENTS = {
  body: {
    experiments: [
      {
        id: 'exp-1',
        key: 'checkout',
        name: 'Checkout',
        trafficAllocation: 100,
        variants: [
          { id: 'v1', name: 'local-a', isControl: true, trafficSplit: 50 },
          { id: 'v2', name: 'local-b', isControl: false, trafficSplit: 50 },
        ],
      },
    ],
  },
};

describe('rivium-ab-testing-node', () => {
  let service: FakeService;
  let sdk: RiviumAbTestingSDK;
  let errors: any[];
  let warn: jest.SpyInstance;
  let now: number;

  beforeEach(() => {
    service = new FakeService();
    service.install();
    sdk = new RiviumAbTestingSDK();
    errors = [];
    sdk.on('error', (e) => errors.push(e.data));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    sdk.reset();
    jest.restoreAllMocks();
  });

  describe('serverSecret', () => {
    it('warns at init when it is missing', async () => {
      await sdk.init({ apiKey: 'rv_test_key' });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('serverSecret');
    });

    it('does not warn when it is set, and sends it', async () => {
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      await sdk.forUser('user-1').getVariant('checkout');

      expect(warn).not.toHaveBeenCalled();
      expect(service.to('/public/assign')[0].secret).toBe('rv_srv_secret');
    });

    it('refused (401): the default, no variant made up here, nothing cached, one error, no storm', async () => {
      service.routes['/public/init'] = EXPERIMENTS;
      service.routes['/public/assign'] = unauthorized('token_required');
      service.routes['/public/flag-evaluation'] = unauthorized('token_required');
      await sdk.init({ apiKey: 'rv_test_key' });
      await settle();
      const user = sdk.forUser('user-1');

      await expect(user.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await expect(user.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await expect(user.getVariantConfig('checkout')).resolves.toBeNull();
      await expect(user.isFeatureEnabled('dark-mode', true)).resolves.toBe(true);
      await expect(sdk.forUser('user-2').getVariant('checkout', 'fallback')).resolves.toBe('fallback');

      expect(service.userCalls()).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('serverSecret');
      expect(errors[0].code).toBe('token_required');

      // Once the secret works, the service's answer is used: nothing was cached meanwhile.
      service.routes['/public/assign'] = assigned('blue');
      now += 31 * 1000;
      await expect(user.getVariant('checkout', 'fallback')).resolves.toBe('blue');
    });

    it('refused (401): events are kept, not discarded, and sent once the service accepts them', async () => {
      service.routes['/public/sync'] = unauthorized('token_required');
      await sdk.init({ apiKey: 'rv_test_key' });
      const user = sdk.forUser('user-1');
      await user.trackView('checkout');
      await user.trackClick('checkout');

      await sdk.flush();
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(1);
      expect(errors).toHaveLength(1);

      service.routes['/public/sync'] = { body: { synced: 2, failed: 0 } };
      now += 31 * 1000;
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(2);
      expect(service.to('/public/sync')[1].body.events).toHaveLength(2);
    });
  });

  describe('variants', () => {
    it('accepts 200 and 201', async () => {
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      service.routes['/public/assign'] = { ...assigned('blue'), status: 201 };
      service.routes['/public/flag-evaluation'] = { status: 201, body: { enabled: true, value: 'on' } };
      await expect(sdk.forUser('user-1').getVariant('checkout', 'fallback')).resolves.toBe('blue');
      await expect(sdk.forUser('user-1').isFeatureEnabled('dark-mode')).resolves.toBe(true);

      service.routes['/public/assign'] = { ...assigned('green'), status: 200 };
      service.routes['/public/flag-evaluation'] = { status: 200, body: { enabled: true, value: 'on' } };
      await expect(sdk.forUser('user-2').getVariant('checkout', 'fallback')).resolves.toBe('green');
      await expect(sdk.forUser('user-2').getFeatureValue('dark-mode')).resolves.toBe('on');
    });

    it('never works out a variant here when the service cannot be reached', async () => {
      service.routes['/public/init'] = EXPERIMENTS;
      service.routes['/public/assign'] = new Error('network down');
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      await settle();

      await expect(sdk.forUser('user-1').getVariant('checkout', 'fallback')).resolves.toBe('fallback');

      service.routes['/public/assign'] = assigned('blue');
      await expect(sdk.forUser('user-1').getVariant('checkout', 'fallback')).resolves.toBe('blue');
    });

    it('a user who is not in the experiment gets the service\'s variant without an error', async () => {
      service.routes['/public/assign'] = assigned('control', { isControl: true, inExperiment: false });
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });

      await expect(sdk.forUser('user-1').getVariant('checkout', 'fallback')).resolves.toBe('control');
      expect(errors).toEqual([]);
    });

    it('honours Retry-After on 429', async () => {
      service.routes['/public/assign'] = { status: 429, headers: { 'Retry-After': '120' }, body: {} };
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      const user = sdk.forUser('user-1');

      await expect(user.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      service.routes['/public/assign'] = assigned('blue');
      now += 119 * 1000;
      await expect(user.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await user.trackView('checkout');
      await sdk.flush();
      expect(service.userCalls()).toHaveLength(1);

      now += 2 * 1000;
      await expect(user.getVariant('checkout', 'fallback')).resolves.toBe('blue');
    });
  });

  describe('forUser', () => {
    it('keeps users apart: own variants, own attributes, own events', async () => {
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      const alice = sdk.forUser('alice', { plan: 'premium' });
      const bob = sdk.forUser('bob');

      const [a, b] = await Promise.all([alice.getVariant('checkout'), bob.getVariant('checkout')]);
      expect(a).toBe('for-alice');
      expect(b).toBe('for-bob');
      // Cached per user: asking again makes no request and mixes nothing up.
      await expect(alice.getVariant('checkout')).resolves.toBe('for-alice');
      await expect(bob.getVariant('checkout')).resolves.toBe('for-bob');
      await expect(alice.getVariantConfig('checkout')).resolves.toEqual({ color: 'for-alice' });

      const calls = service.to('/public/assign');
      expect(calls).toHaveLength(2);
      expect(calls.find((c) => c.body.userId === 'alice')!.body.userAttributes).toEqual({ plan: 'premium' });
      expect(calls.find((c) => c.body.userId === 'bob')!.body.userAttributes).toBeUndefined();

      await alice.trackView('checkout');
      await bob.trackConversion('checkout', 5);
      await sdk.flush();
      const events = service.to('/public/sync')[0].body.events;
      expect(events.map((e: any) => [e.userId, e.variantId])).toEqual([
        ['alice', 'id-for-alice'],
        ['bob', 'id-for-bob'],
      ]);
      // The single-user methods are untouched by forUser().
      expect(sdk.getUserId()).toBeNull();
    });
  });

  describe('the event queue', () => {
    it('keeps at most 1000 events and sends them in batches of 100, each once', async () => {
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret', maxQueueSize: 5000 });
      const user = sdk.forUser('user-1');
      // The service is down while the events come in.
      service.routes['/public/sync'] = new Error('network down');
      for (let i = 0; i < 1005; i++) {
        await user.trackCustomEvent('checkout', `event-${i}`);
      }
      await settle();
      const failedAttempts = service.to('/public/sync').length;

      service.routes['/public/sync'] = (call) => ({ body: { synced: call.body.events.length, failed: 0 } });
      now += 10 * 60 * 1000;
      await Promise.all([sdk.flush(), sdk.flush(), sdk.flush()]);

      const sent = service.to('/public/sync').slice(failedAttempts);
      expect(sent.map((c) => c.body.events.length)).toEqual(new Array(10).fill(100));
      const delivered = sent.flatMap((c) => c.body.events.map((e: any) => e.clientEventId));
      expect(new Set(delivered).size).toBe(1000);
      expect(sent[0].body.events[0].eventName).toBe('event-5');
    });

    it('a refused batch (400) is reported and does not take the rest with it', async () => {
      let request = 0;
      service.routes['/public/sync'] = (call) =>
        ++request === 1 ? { status: 400, body: {} } : { body: { synced: call.body.events.length, failed: 0 } };
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      const user = sdk.forUser('user-1');
      for (let i = 0; i < 99; i++) await user.trackView('checkout');
      // The hundredth event starts a flush; add the rest while it runs.
      for (let i = 0; i < 51; i++) await user.trackView('checkout');
      await sdk.flush();
      await settle();

      expect(service.to('/public/sync').map((c) => c.body.events.length)).toEqual([100, 50]);
      expect(errors).toEqual([{ message: 'Sync refused: HTTP 400', dropped: 100 }]);
    });

    it('5xx: keeps the events, reports, and backs off', async () => {
      service.routes['/public/sync'] = { status: 503, body: {} };
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      await sdk.forUser('user-1').trackView('checkout');

      await sdk.flush();
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(1);
      expect(errors).toEqual([{ message: 'Sync failed: HTTP 503' }]);

      service.routes['/public/sync'] = { body: { synced: 1, failed: 0 } };
      now += 31 * 1000;
      await sdk.flush();
      expect(service.to('/public/sync')[1].body.events).toHaveLength(1);
    });

    it('event limit reached: keeps the events and says so once', async () => {
      service.routes['/public/sync'] = {
        status: 403,
        body: { statusCode: 403, error: 'EVENT_LIMIT_EXCEEDED', code: 'event_limit_reached' },
      };
      await sdk.init({ apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret' });
      await sdk.forUser('user-1').trackView('checkout');

      await sdk.flush();
      await sdk.flush();
      now += 31 * 1000;
      await sdk.flush();

      expect(service.to('/public/sync')).toHaveLength(2);
      expect(errors).toEqual([{ message: 'Event limit reached', code: 'event_limit_reached' }]);
    });

    it('destroy() reports events it could not send', async () => {
      service.routes['/public/sync'] = unauthorized('token_required');
      await sdk.init({ apiKey: 'rv_test_key' });
      await sdk.forUser('user-1').trackView('checkout');

      await sdk.destroy();

      expect(errors.map((e) => e.dropped)).toContain(1);
    });
  });

  it('declares the Node.js version it needs (global fetch)', () => {
    const { engines } = require('../../package.json');
    expect(engines.node).toBe('>=18.0.0');
  });
});
