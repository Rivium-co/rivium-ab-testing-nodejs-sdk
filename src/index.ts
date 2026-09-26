import { createHash } from './hash';

const API_URL = 'https://abtest.rivium.co';
const AUTH_URL = 'https://auth.rivium.co';
const SDK_VERSION = '0.2.0';

// ============================================
// TYPES & INTERFACES
// ============================================

export interface RiviumAbTestingConfig {
  /** API key for authentication (format: rv_live_xxx or rv_test_xxx) */
  apiKey: string;
  /**
   * Your project's server secret. This SDK runs on your server, so it can
   * prove that with the secret; the service then trusts the user ids you pass,
   * even when the project requires signed user tokens. Keep it on the server:
   * never put it in an app or a browser bundle.
   */
  serverSecret?: string;
  debug?: boolean;
  /** How often queued events are sent, in milliseconds. Default 30000. */
  flushInterval?: number;
  /** Most events kept in memory while waiting to be sent. Default 1000. */
  maxQueueSize?: number;
  /**
   * Most (user, experiment) assignments kept in memory. A server sees many
   * users, so the cache is bounded; the oldest entries are dropped first.
   * Default 10000.
   */
  maxCachedAssignments?: number;
}

export interface Experiment {
  id: string;
  key: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'archived';
  trafficAllocation: number;
  variants: Variant[];
  targetingRules?: Record<string, unknown>;
}

export interface Variant {
  id: string;
  key: string;
  name: string;
  trafficSplit: number;
  isControl: boolean;
  config?: Record<string, unknown>;
}

export interface Assignment {
  experimentId: string;
  experimentKey: string;
  variantId: string;
  variantKey: string;
  isControl: boolean;
  config?: Record<string, unknown>;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  rolloutPercentage: number;
  targetingRules?: Record<string, unknown>;
  variants?: FlagVariant[];
  defaultValue?: unknown;
}

export interface FlagVariant {
  key: string;
  value?: unknown;
  weight: number;
}

export interface UserToken {
  token: string;
  userId: string;
  /** Seconds until the token expires. */
  expiresIn: number;
}

export enum EventType {
  VIEW = 'view',
  CLICK = 'click',
  CONVERSION = 'conversion',
  CUSTOM = 'custom',
  SCROLL = 'scroll',
  FORM_SUBMIT = 'form_submit',
  SEARCH = 'search',
  SHARE = 'share',
  ADD_TO_CART = 'add_to_cart',
  REMOVE_FROM_CART = 'remove_from_cart',
  BEGIN_CHECKOUT = 'begin_checkout',
  PURCHASE = 'purchase',
  VIDEO_START = 'video_start',
  VIDEO_COMPLETE = 'video_complete',
  SIGN_UP = 'sign_up',
  LOGIN = 'login',
  LOGOUT = 'logout',
}

export type RiviumAbTestingEventType =
  | 'initialized'
  | 'error'
  | 'experimentAssigned'
  | 'experimentsRefreshed'
  | 'featureFlagsRefreshed'
  | 'syncCompleted';

export interface RiviumAbTestingEvent {
  type: RiviumAbTestingEventType;
  data?: unknown;
}

type EventCallback = (event: RiviumAbTestingEvent) => void;

// ============================================
// INTERNAL TYPES
// ============================================

interface UserContext {
  userId: string;
  attributes: Record<string, unknown>;
}

interface TrackOptions {
  eventName?: string;
  eventValue?: number;
  metadata?: Record<string, unknown>;
}

interface QueuedEvent {
  id: string;
  experimentId: string;
  variantId: string;
  userId: string;
  eventType: string;
  eventName: string;
  eventValue?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface CachedAssignment {
  experimentId: string;
  variantId: string;
  variantName: string;
  config?: Record<string, unknown>;
}

interface CachedExperiment {
  id: string;
  key: string;
  name: string;
  trafficAllocation: number;
  variants: {
    id: string;
    key?: string;
    name: string;
    config?: Record<string, unknown>;
    isControl: boolean;
    trafficSplit: number;
  }[];
}

interface SyncConfig {
  syncIntervalSeconds: number;
  maxBatchSize: number;
  maxOfflineEvents: number;
}

function withProperties(
  extra: Record<string, unknown>,
  properties?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const metadata = { ...extra, ...properties };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

// ============================================
// USER-FACING API (shared by the SDK and per-user handles)
// ============================================

/**
 * Everything that acts on behalf of one user. `RiviumAbTesting.forUser(id)`
 * returns one bound to that user; the SDK object itself acts for the user set
 * with `setUserId` (fine for scripts and single-user processes, but on a
 * server handling many users at once use `forUser`, once per request).
 */
export abstract class RiviumAbTestingClient {
  /** @internal */
  protected abstract sdk(): RiviumAbTestingSDK;
  /** @internal */
  protected abstract user(): UserContext;

  getVariant(experimentKey: string, defaultVariant: string = 'control'): Promise<string> {
    return this.sdk()._getVariant(this.user(), experimentKey, defaultVariant);
  }

  getVariantConfig(experimentKey: string): Promise<Record<string, unknown> | null> {
    return this.sdk()._getVariantConfig(this.user(), experimentKey);
  }

  isFeatureEnabled(featureKey: string, defaultValue: boolean = false): Promise<boolean> {
    return this.sdk()
      ._evaluateFlag(this.user(), featureKey)
      .then((data) => (data?.enabled as boolean | undefined) ?? defaultValue);
  }

  getFeatureValue(featureKey: string, defaultValue?: unknown): Promise<unknown> {
    return this.sdk()
      ._evaluateFlag(this.user(), featureKey)
      .then((data) => data?.value ?? defaultValue);
  }

  // Core events

  trackView(experimentKey: string): Promise<void> {
    return this.track(experimentKey, EventType.VIEW);
  }

  trackClick(experimentKey: string): Promise<void> {
    return this.track(experimentKey, EventType.CLICK);
  }

  trackConversion(experimentKey: string, value?: number): Promise<void> {
    return this.track(experimentKey, EventType.CONVERSION, { eventValue: value });
  }

  trackCustomEvent(
    experimentKey: string,
    eventName: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    return this.track(experimentKey, EventType.CUSTOM, { eventName, metadata: properties });
  }

  // Engagement events

  trackScroll(experimentKey: string, depth?: number, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.SCROLL, { eventValue: depth, metadata: properties });
  }

  trackFormSubmit(experimentKey: string, formName?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.FORM_SUBMIT, { eventName: formName, metadata: properties });
  }

  trackSearch(experimentKey: string, query?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.SEARCH, {
      metadata: withProperties(query ? { query } : {}, properties),
    });
  }

  trackShare(experimentKey: string, method?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.SHARE, {
      metadata: withProperties(method ? { method } : {}, properties),
    });
  }

  // E-commerce events

  trackAddToCart(
    experimentKey: string,
    value?: number,
    productId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    return this.track(experimentKey, EventType.ADD_TO_CART, {
      eventValue: value,
      metadata: withProperties(productId ? { productId } : {}, properties),
    });
  }

  trackRemoveFromCart(
    experimentKey: string,
    value?: number,
    productId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    return this.track(experimentKey, EventType.REMOVE_FROM_CART, {
      eventValue: value,
      metadata: withProperties(productId ? { productId } : {}, properties),
    });
  }

  trackBeginCheckout(experimentKey: string, value?: number, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.BEGIN_CHECKOUT, { eventValue: value, metadata: properties });
  }

  trackPurchase(
    experimentKey: string,
    value: number,
    transactionId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    return this.track(experimentKey, EventType.PURCHASE, {
      eventValue: value,
      metadata: withProperties(transactionId ? { transactionId } : {}, properties),
    });
  }

  // Media events

  trackVideoStart(experimentKey: string, videoId?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.VIDEO_START, {
      metadata: withProperties(videoId ? { videoId } : {}, properties),
    });
  }

  trackVideoComplete(experimentKey: string, videoId?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.VIDEO_COMPLETE, {
      metadata: withProperties(videoId ? { videoId } : {}, properties),
    });
  }

  // User auth events

  trackSignUp(experimentKey: string, method?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.SIGN_UP, {
      metadata: withProperties(method ? { method } : {}, properties),
    });
  }

  trackLogin(experimentKey: string, method?: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.LOGIN, {
      metadata: withProperties(method ? { method } : {}, properties),
    });
  }

  trackLogout(experimentKey: string, properties?: Record<string, unknown>): Promise<void> {
    return this.track(experimentKey, EventType.LOGOUT, { metadata: properties });
  }

  // Generic

  trackEvent(
    experimentKey: string,
    eventType: EventType,
    eventName?: string,
    value?: number,
    properties?: Record<string, unknown>
  ): Promise<void> {
    return this.track(experimentKey, eventType, {
      eventName: eventName || eventType,
      eventValue: value,
      metadata: properties,
    });
  }

  private track(experimentKey: string, eventType: EventType, options?: TrackOptions): Promise<void> {
    return this.sdk()._track(this.user(), experimentKey, eventType, options);
  }
}

/** One user's view of the SDK. Cheap to create; make one per request. */
export class RiviumAbTestingUser extends RiviumAbTestingClient {
  private readonly context: UserContext;

  /** @internal */
  constructor(private readonly owner: RiviumAbTestingSDK, userId: string, attributes: Record<string, unknown>) {
    super();
    this.context = { userId, attributes: { ...attributes } };
  }

  get userId(): string {
    return this.context.userId;
  }

  /** @internal */
  protected sdk(): RiviumAbTestingSDK {
    return this.owner;
  }

  /** @internal */
  protected user(): UserContext {
    return this.context;
  }
}

// ============================================
// SDK IMPLEMENTATION
// ============================================

export class RiviumAbTestingSDK extends RiviumAbTestingClient {
  private listeners: Map<string, EventCallback[]> = new Map();
  private isInitialized = false;
  private config: RiviumAbTestingConfig | null = null;

  // The user for the single-user methods (setUserId). Per-request code should
  // use forUser() instead, which never touches this.
  private userId: string | null = null;
  private userAttributes: Record<string, unknown> = {};

  private cachedExperiments: CachedExperiment[] = [];
  // Keyed by user AND experiment: one user's variant must never be served to
  // another. Insertion-ordered, so the first key is the oldest.
  private assignments: Map<string, CachedAssignment> = new Map();
  private eventQueue: QueuedEvent[] = [];

  // Sync
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private syncConfig: SyncConfig = {
    syncIntervalSeconds: 30,
    maxBatchSize: 100,
    maxOfflineEvents: 1000,
  };

  // ============================================
  // INITIALIZATION
  // ============================================

  async init(config: RiviumAbTestingConfig): Promise<void> {
    if (this.isInitialized) return;

    this.config = config;

    const interval = config.flushInterval || 30000;
    this.syncConfig.syncIntervalSeconds = Math.max(1, Math.floor(interval / 1000));
    if (config.maxQueueSize) this.syncConfig.maxOfflineEvents = config.maxQueueSize;
    this.startSyncTimer();

    this.isInitialized = true;

    // Fetch fresh experiments
    this.fetchExperiments().catch(() => {});

    this.emit('initialized', {});
  }

  // ============================================
  // USERS
  // ============================================

  /**
   * A handle that acts for one user. Use this on a server: create one per
   * request with that request's user, and nothing leaks between users.
   *
   *   const user = RiviumAbTesting.forUser(req.user.id, { country: 'DE' });
   *   const variant = await user.getVariant('checkout-button');
   */
  forUser(userId: string, attributes: Record<string, unknown> = {}): RiviumAbTestingUser {
    this.ensureInitialized();
    if (!userId) {
      throw new Error('forUser() requires a userId');
    }
    return new RiviumAbTestingUser(this, userId, attributes);
  }

  /**
   * Sets the user for the SDK's own methods. Only for single-user processes:
   * on a server two requests would overwrite each other's user. Use forUser().
   */
  setUserId(userId: string): void {
    this.ensureInitialized();
    if (userId !== this.userId) {
      // A different person now: their attributes are not the last user's.
      this.userAttributes = {};
    }
    this.userId = userId;
  }

  getUserId(): string | null {
    this.ensureInitialized();
    return this.userId;
  }

  setUserAttributes(attributes: Record<string, unknown>): void {
    this.ensureInitialized();
    this.userAttributes = { ...this.userAttributes, ...attributes };
  }

  /**
   * Mints a Rivium user token for one of your users, to hand to your app. The
   * app SDKs send it so the service knows which user they act for. Requires
   * `serverSecret`. The same token works for Rivium Chat and Sync.
   *
   *   app.post('/rivium-token', async (req, res) => {
   *     res.json(await RiviumAbTesting.createUserToken(req.session.userId));
   *   });
   */
  async createUserToken(userId: string, expiresIn?: number): Promise<UserToken> {
    this.ensureInitialized();
    if (!userId) {
      throw new Error('createUserToken() requires a userId');
    }
    if (!this.config!.serverSecret) {
      throw new Error('createUserToken() requires serverSecret in init()');
    }

    const response = await fetch(`${AUTH_URL}/users/token`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(expiresIn === undefined ? { userId } : { userId, expiresIn }),
    });
    if (!response.ok) {
      throw new Error(`createUserToken failed: HTTP ${response.status}`);
    }
    return (await response.json()) as UserToken;
  }

  // ============================================
  // EXPERIMENTS
  // ============================================

  async refreshExperiments(): Promise<void> {
    this.ensureInitialized();
    await this.fetchExperiments();
  }

  getExperiments(): Experiment[] {
    this.ensureInitialized();
    return this.cachedExperiments.map((e) => ({
      id: e.id,
      key: e.key,
      name: e.name,
      status: 'running' as const,
      trafficAllocation: e.trafficAllocation,
      variants: e.variants.map((v) => ({
        id: v.id,
        key: v.key || v.id,
        name: v.name,
        trafficSplit: v.trafficSplit,
        isControl: v.isControl,
        config: v.config,
      })),
    }));
  }

  // ============================================
  // FEATURE FLAGS (not user specific)
  // ============================================

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flags`, { headers: this.headers() });
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        return (data.flags as FeatureFlag[]) || [];
      }
    } catch (e) {
      this.debugLog('Failed to get feature flags:', e);
    }

    return [];
  }

  async refreshFeatureFlags(): Promise<void> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flags`, { headers: this.headers() });
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        this.emit('featureFlagsRefreshed', data);
      }
    } catch (e) {
      this.debugLog('Failed to refresh feature flags:', e);
      this.emit('error', { message: `Failed to refresh feature flags: ${e}` });
    }
  }

  // ============================================
  // FLUSH & LIFECYCLE
  // ============================================

  async flush(): Promise<void> {
    this.ensureInitialized();
    await this.syncEvents();
  }

  async destroy(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    // Flush remaining events before destroying
    if (this.eventQueue.length > 0) {
      await this.syncEvents();
    }

    this.clearState();
  }

  reset(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.clearState();
  }

  // ============================================
  // EVENT LISTENERS
  // ============================================

  on(event: RiviumAbTestingEventType, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);

    return () => this.off(event, callback);
  }

  off(event: RiviumAbTestingEventType, callback: EventCallback): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  // ============================================
  // RiviumAbTestingClient: the SDK acts for setUserId's user
  // ============================================

  /** @internal */
  protected sdk(): RiviumAbTestingSDK {
    return this;
  }

  /** @internal */
  protected user(): UserContext {
    this.ensureInitialized();
    if (!this.userId) {
      throw new Error('User ID not set. Call setUserId() first, or use forUser(userId).');
    }
    return { userId: this.userId, attributes: this.userAttributes };
  }

  // ============================================
  // INTERNAL: per-user operations (called by RiviumAbTestingClient)
  // ============================================

  /** @internal */
  async _getVariant(user: UserContext, experimentKey: string, defaultVariant: string): Promise<string> {
    this.ensureInitialized();

    const cached = this.getCachedAssignment(user.userId, experimentKey);
    if (cached) {
      return cached.variantName;
    }

    try {
      const response = await fetch(`${API_URL}/public/assign`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          experimentKey,
          userId: user.userId,
          ...(Object.keys(user.attributes).length > 0 ? { userAttributes: user.attributes } : {}),
        }),
      });

      if (response.ok) {
        const body = (await response.json()) as { data?: Record<string, unknown> };
        const data = body.data ?? {};
        const variantName = (data.variantName as string) || (data.variantKey as string);

        if (variantName) {
          this.cacheAssignment(user.userId, experimentKey, {
            experimentId: data.experimentId as string,
            variantId: data.variantId as string,
            variantName,
            config: data.config as Record<string, unknown> | undefined,
          });

          this.emit('experimentAssigned', {
            userId: user.userId,
            experimentKey,
            variantKey: variantName,
            config: data.config,
          });

          return variantName;
        }
      } else {
        this.debugLog(`Assignment for ${experimentKey} refused: HTTP ${response.status}`);
      }
    } catch (e) {
      this.debugLog('Failed to get assignment from server:', e);
    }

    // Fallback: local bucketing
    return this.getLocalAssignment(user, experimentKey, defaultVariant);
  }

  /** @internal */
  async _getVariantConfig(user: UserContext, experimentKey: string): Promise<Record<string, unknown> | null> {
    this.ensureInitialized();

    // The assignment carries the variant's config; make sure there is one.
    if (!this.getCachedAssignment(user.userId, experimentKey)) {
      await this._getVariant(user, experimentKey, 'control');
    }
    const cached = this.getCachedAssignment(user.userId, experimentKey);
    if (!cached) return null;
    if (cached.config) return cached.config;

    const experiment = this.findExperiment(experimentKey);
    const variant = experiment?.variants.find((v) => v.id === cached.variantId);
    return variant?.config || null;
  }

  /** @internal */
  async _evaluateFlag(user: UserContext, featureKey: string): Promise<Record<string, unknown> | null> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flag-evaluation`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          flagKey: featureKey,
          userId: user.userId,
          userAttributes: user.attributes,
        }),
      });

      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }
    } catch (e) {
      this.debugLog('Failed to evaluate feature flag:', e);
    }

    return null;
  }

  /** @internal */
  async _track(
    user: UserContext,
    experimentKey: string,
    eventType: EventType,
    options?: TrackOptions
  ): Promise<void> {
    this.ensureInitialized();

    const cached = this.getCachedAssignment(user.userId, experimentKey);

    const event: QueuedEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      experimentId: experimentKey,
      // Empty when this user has no assignment here yet; the service then
      // looks up (or makes) the assignment for this user.
      variantId: cached?.variantId || '',
      userId: user.userId,
      eventType,
      eventName: options?.eventName || eventType,
      eventValue: options?.eventValue,
      metadata: options?.metadata,
      timestamp: new Date().toISOString(),
    };

    if (this.eventQueue.length >= this.syncConfig.maxOfflineEvents) {
      this.eventQueue.shift();
    }
    this.eventQueue.push(event);

    this.debugLog(`Queued ${eventType} event for experiment ${experimentKey}`);

    // Auto-flush if batch is full
    if (this.eventQueue.length >= this.syncConfig.maxBatchSize) {
      this.syncEvents().catch(() => {});
    }
  }

  // ============================================
  // PRIVATE
  // ============================================

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config!.apiKey,
      ...(this.config!.serverSecret ? { 'x-server-secret': this.config!.serverSecret } : {}),
    };
  }

  private emit(event: RiviumAbTestingEventType, data: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb({ type: event, data }));
    }
  }

  private debugLog(message: string, detail?: unknown): void {
    if (this.config?.debug) {
      if (detail === undefined) console.log(`RiviumAbTesting: ${message}`);
      else console.log(`RiviumAbTesting: ${message}`, detail);
    }
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('RiviumAbTesting SDK not initialized. Call init() first.');
    }
  }

  private clearState(): void {
    this.userId = null;
    this.userAttributes = {};
    this.cachedExperiments = [];
    this.assignments.clear();
    this.eventQueue = [];
    this.isInitialized = false;
  }

  private assignmentKey(userId: string, experimentKey: string): string {
    return `${userId}\u0000${experimentKey}`;
  }

  private getCachedAssignment(userId: string, experimentKey: string): CachedAssignment | undefined {
    return this.assignments.get(this.assignmentKey(userId, experimentKey));
  }

  private cacheAssignment(userId: string, experimentKey: string, assignment: CachedAssignment): void {
    const key = this.assignmentKey(userId, experimentKey);
    this.assignments.delete(key);
    this.assignments.set(key, assignment);

    const max = this.config?.maxCachedAssignments ?? 10000;
    while (this.assignments.size > max) {
      const oldest = this.assignments.keys().next().value as string;
      this.assignments.delete(oldest);
    }
  }

  private findExperiment(experimentKey: string): CachedExperiment | undefined {
    return this.cachedExperiments.find((e) => e.key === experimentKey || e.id === experimentKey);
  }

  private startSyncTimer(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(
      () => this.syncEvents().catch(() => {}),
      this.syncConfig.syncIntervalSeconds * 1000
    );
    // Do not keep a short-lived process (a script, a serverless call) alive.
    (this.syncTimer as { unref?: () => void }).unref?.();
  }

  private async syncEvents(): Promise<void> {
    if (this.isSyncing || this.eventQueue.length === 0) return;

    this.isSyncing = true;

    try {
      const batch = this.eventQueue.slice(0, this.syncConfig.maxBatchSize);

      const response = await fetch(`${API_URL}/public/sync`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          events: batch.map((e) => ({
            experimentId: e.experimentId,
            variantId: e.variantId,
            userId: e.userId,
            eventType: e.eventType,
            eventName: e.eventName,
            eventValue: e.eventValue,
            metadata: e.metadata,
            timestamp: e.timestamp,
            clientEventId: e.id,
          })),
          sdkVersion: `node-${SDK_VERSION}`,
        }),
      });

      if (response.ok) {
        const result = (await response.json()) as Record<string, unknown>;
        // The service has taken the whole batch. Events it could not record
        // (an experiment that no longer exists, say) would fail again, so they
        // are not retried.
        this.eventQueue.splice(0, batch.length);

        this.emit('syncCompleted', {
          synced: (result.synced as number) || 0,
          failed: (result.failed as number) || 0,
          pending: this.eventQueue.length,
        });
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // The request itself is wrong (bad key, bad secret); retrying the
        // same events cannot succeed.
        this.eventQueue.splice(0, batch.length);
        this.emit('error', { message: `Sync refused: HTTP ${response.status}` });
      }
      // 429 and 5xx: keep the events and try again on the next tick.
    } catch (e) {
      this.emit('error', { message: `Sync failed: ${e}` });
    } finally {
      this.isSyncing = false;
    }
  }

  private async fetchExperiments(): Promise<void> {
    try {
      const response = await fetch(
        `${API_URL}/public/init?platform=node&sdkVersion=${SDK_VERSION}`,
        { headers: this.headers() }
      );

      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;

        const experimentsList = (data.experiments as Array<Record<string, unknown>>) || [];
        this.cachedExperiments = experimentsList.map((e) => ({
          id: e.id as string,
          key: (e.key as string) || (e.id as string),
          name: e.name as string,
          trafficAllocation: (e.trafficAllocation as number) ?? 100,
          variants: ((e.variants as Array<Record<string, unknown>>) || []).map((v) => ({
            id: v.id as string,
            key: (v.key as string) || undefined,
            name: v.name as string,
            config: (v.config as Record<string, unknown>) || undefined,
            isControl: (v.isControl as boolean) ?? false,
            trafficSplit: (v.trafficSplit as number) ?? 50,
          })),
        }));

        const serverConfig = data.config as Partial<SyncConfig> | undefined;
        if (serverConfig) {
          this.syncConfig = {
            syncIntervalSeconds: serverConfig.syncIntervalSeconds ?? this.syncConfig.syncIntervalSeconds,
            maxBatchSize: serverConfig.maxBatchSize ?? this.syncConfig.maxBatchSize,
            maxOfflineEvents: this.config?.maxQueueSize ?? serverConfig.maxOfflineEvents ?? this.syncConfig.maxOfflineEvents,
          };
          this.startSyncTimer();
        }

        this.emit('experimentsRefreshed', { count: this.cachedExperiments.length });
        this.debugLog(`Fetched ${this.cachedExperiments.length} experiments`);
      }
    } catch (e) {
      this.debugLog('Failed to fetch experiments:', e);
      this.emit('error', { message: `Failed to fetch experiments: ${e}` });
    }
  }

  private getLocalAssignment(user: UserContext, experimentKey: string, defaultVariant: string): string {
    const experiment = this.findExperiment(experimentKey);
    if (!experiment) return defaultVariant;

    const bucket = this.getBucket(user.userId, experimentKey);
    if (bucket > experiment.trafficAllocation) {
      const control = experiment.variants.find((v) => v.isControl);
      return control ? control.name : defaultVariant;
    }

    let cumulativeSplit = 0;
    const variantBucket = this.getBucket(user.userId, `${experimentKey}:variant`);

    for (const variant of experiment.variants) {
      cumulativeSplit += variant.trafficSplit;
      if (variantBucket <= cumulativeSplit) {
        this.cacheAssignment(user.userId, experimentKey, {
          experimentId: experiment.id,
          variantId: variant.id,
          variantName: variant.name,
          config: variant.config,
        });

        this.emit('experimentAssigned', {
          userId: user.userId,
          experimentKey,
          variantKey: variant.name,
          config: variant.config,
        });

        return variant.name;
      }
    }

    return defaultVariant;
  }

  private getBucket(userId: string, salt: string): number {
    const hash = createHash(`${userId}:${salt}`);
    const hashInt = parseInt(hash.substring(0, 8), 16);
    return (hashInt % 100) + 1;
  }
}

// Default singleton instance
export const RiviumAbTesting = new RiviumAbTestingSDK();
export default RiviumAbTesting;
