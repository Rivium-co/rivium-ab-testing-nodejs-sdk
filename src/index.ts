import { createHash } from './hash';

const API_URL = 'https://abtest.rivium.co';

// ============================================
// TYPES & INTERFACES
// ============================================

export interface RiviumAbTestingConfig {
  /** API key for authentication (format: rv_live_xxx or rv_test_xxx) */
  apiKey: string;
  debug?: boolean;
  flushInterval?: number;
  maxQueueSize?: number;
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
  retryCount: number;
}

interface CachedAssignment {
  experimentId: string;
  variantId: string;
  variantName: string;
  assignedAt: string;
}

interface CachedExperiment {
  id: string;
  name: string;
  trafficAllocation: number;
  variants: {
    id: string;
    name: string;
    config?: Record<string, unknown>;
    isControl: boolean;
    trafficSplit: number;
  }[];
  cachedAt: string;
}

interface SyncConfig {
  syncIntervalSeconds: number;
  maxBatchSize: number;
  maxOfflineEvents: number;
  maxRetries: number;
}

// ============================================
// SDK IMPLEMENTATION
// ============================================

export class RiviumAbTestingSDK {
  private listeners: Map<string, EventCallback[]> = new Map();
  private isInitialized = false;
  private config: RiviumAbTestingConfig | null = null;

  // State (in-memory)
  private userId: string | null = null;
  private userAttributes: Record<string, unknown> = {};
  private cachedExperiments: CachedExperiment[] = [];
  private assignments: Map<string, CachedAssignment> = new Map();
  private eventQueue: QueuedEvent[] = [];

  // Sync
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private syncConfig: SyncConfig = {
    syncIntervalSeconds: 30,
    maxBatchSize: 100,
    maxOfflineEvents: 1000,
    maxRetries: 3,
  };

  // ============================================
  // INITIALIZATION
  // ============================================

  async init(config: RiviumAbTestingConfig): Promise<void> {
    if (this.isInitialized) return;

    this.config = config;

    const interval = config.flushInterval || 30000;
    this.syncConfig.syncIntervalSeconds = Math.floor(interval / 1000);
    this.startSyncTimer();

    this.isInitialized = true;

    // Fetch fresh experiments
    this.fetchExperiments().catch(() => {});

    this.emit('initialized', {});
  }

  // ============================================
  // USER MANAGEMENT
  // ============================================

  setUserId(userId: string): void {
    this.ensureInitialized();
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

  // ============================================
  // EXPERIMENT ASSIGNMENT
  // ============================================

  async getVariant(
    experimentKey: string,
    defaultVariant: string = 'control'
  ): Promise<string> {
    this.ensureInitialized();
    this.ensureUserId();

    // Check cached assignment (sticky bucketing)
    const cached = this.assignments.get(experimentKey);
    if (cached) {
      return cached.variantName;
    }

    // Try server assignment
    try {
      const response = await fetch(`${API_URL}/public/assign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          experimentId: experimentKey,
          userId: this.userId,
          context: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        const variantName = data.variantName as string;

        this.assignments.set(experimentKey, {
          experimentId: experimentKey,
          variantId: data.variantId as string,
          variantName,
          assignedAt: new Date().toISOString(),
        });

        this.emit('experimentAssigned', {
          experimentKey,
          variantKey: variantName,
          config: data.config,
        });

        return variantName;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get assignment from server:', e);
      }
    }

    // Fallback: local bucketing
    return this.getLocalAssignment(experimentKey, defaultVariant);
  }

  async getVariantConfig(
    experimentKey: string
  ): Promise<Record<string, unknown> | null> {
    this.ensureInitialized();

    try {
      const response = await fetch(
        `${API_URL}/public/variant-config?experimentId=${experimentKey}&userId=${this.userId}`,
        {
          headers: { 'x-api-key': this.config!.apiKey },
        }
      );

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        return (data.config as Record<string, unknown>) || null;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get variant config:', e);
      }
    }

    // Fallback to cached
    const experiment = this.cachedExperiments.find(
      (exp) => exp.id === experimentKey || exp.name === experimentKey
    );
    if (experiment) {
      const cached = this.assignments.get(experimentKey);
      if (cached) {
        const variant = experiment.variants.find(
          (v) => v.id === cached.variantId
        );
        return variant?.config || null;
      }
    }

    return null;
  }

  // ============================================
  // CORE EVENT TRACKING
  // ============================================

  async trackView(experimentKey: string): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.VIEW);
  }

  async trackClick(experimentKey: string): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.CLICK);
  }

  async trackConversion(experimentKey: string, value?: number): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.CONVERSION, {
      eventValue: value,
    });
  }

  async trackCustomEvent(
    experimentKey: string,
    eventName: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.CUSTOM, {
      eventName,
      metadata: properties,
    });
  }

  // ============================================
  // ENGAGEMENT EVENTS
  // ============================================

  async trackScroll(
    experimentKey: string,
    depth?: number,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.SCROLL, {
      eventValue: depth,
      metadata: properties,
    });
  }

  async trackFormSubmit(
    experimentKey: string,
    formName?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.FORM_SUBMIT, {
      eventName: formName,
      metadata: properties,
    });
  }

  async trackSearch(
    experimentKey: string,
    query?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(query ? { query } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.SEARCH, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackShare(
    experimentKey: string,
    method?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(method ? { method } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.SHARE, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  // ============================================
  // E-COMMERCE EVENTS
  // ============================================

  async trackAddToCart(
    experimentKey: string,
    value?: number,
    productId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(productId ? { productId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.ADD_TO_CART, {
      eventValue: value,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackRemoveFromCart(
    experimentKey: string,
    value?: number,
    productId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(productId ? { productId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.REMOVE_FROM_CART, {
      eventValue: value,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackBeginCheckout(
    experimentKey: string,
    value?: number,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.BEGIN_CHECKOUT, {
      eventValue: value,
      metadata: properties,
    });
  }

  async trackPurchase(
    experimentKey: string,
    value: number,
    transactionId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(transactionId ? { transactionId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.PURCHASE, {
      eventValue: value,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  // ============================================
  // MEDIA EVENTS
  // ============================================

  async trackVideoStart(
    experimentKey: string,
    videoId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(videoId ? { videoId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.VIDEO_START, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackVideoComplete(
    experimentKey: string,
    videoId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(videoId ? { videoId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.VIDEO_COMPLETE, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  // ============================================
  // USER AUTH EVENTS
  // ============================================

  async trackSignUp(
    experimentKey: string,
    method?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(method ? { method } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.SIGN_UP, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackLogin(
    experimentKey: string,
    method?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    const metadata = {
      ...(method ? { method } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.LOGIN, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackLogout(
    experimentKey: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.LOGOUT, {
      metadata: properties,
    });
  }

  // ============================================
  // GENERIC EVENT TRACKING
  // ============================================

  async trackEvent(
    experimentKey: string,
    eventType: EventType,
    eventName?: string,
    value?: number,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, eventType, {
      eventName: eventName || eventType,
      eventValue: value,
      metadata: properties,
    });
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
      key: e.id,
      name: e.name,
      status: 'running' as const,
      trafficAllocation: e.trafficAllocation,
      variants: e.variants.map((v) => ({
        id: v.id,
        key: v.id,
        name: v.name,
        trafficSplit: v.trafficSplit,
        isControl: v.isControl,
        config: v.config,
      })),
    }));
  }

  // ============================================
  // FEATURE FLAGS
  // ============================================

  async isFeatureEnabled(
    featureKey: string,
    defaultValue: boolean = false
  ): Promise<boolean> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flag-evaluation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          flagKey: featureKey,
          userId: this.userId || '',
          userAttributes: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        return (data.enabled as boolean) ?? defaultValue;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to check feature flag:', e);
      }
    }

    return defaultValue;
  }

  async getFeatureValue(
    featureKey: string,
    defaultValue?: unknown
  ): Promise<unknown> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flag-evaluation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          flagKey: featureKey,
          userId: this.userId || '',
          userAttributes: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        return data.value ?? defaultValue;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get feature value:', e);
      }
    }

    return defaultValue;
  }

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flags`, {
        headers: { 'x-api-key': this.config!.apiKey },
      });

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        return (data.flags as FeatureFlag[]) || [];
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get feature flags:', e);
      }
    }

    return [];
  }

  async refreshFeatureFlags(): Promise<void> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flags`, {
        headers: { 'x-api-key': this.config!.apiKey },
      });

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        this.emit('featureFlagsRefreshed', data);
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to refresh feature flags:', e);
      }
      this.emit('error', {
        message: `Failed to refresh feature flags: ${e}`,
      });
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

    this.userId = null;
    this.userAttributes = {};
    this.cachedExperiments = [];
    this.assignments.clear();
    this.eventQueue = [];
    this.isInitialized = false;
  }

  reset(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    this.userId = null;
    this.userAttributes = {};
    this.cachedExperiments = [];
    this.assignments.clear();
    this.eventQueue = [];
    this.isInitialized = false;
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
  // PRIVATE: EVENT SYSTEM
  // ============================================

  private emit(event: RiviumAbTestingEventType, data: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb({ type: event, data }));
    }
  }

  // ============================================
  // PRIVATE: VALIDATION
  // ============================================

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(
        'RiviumAbTesting SDK not initialized. Call init() first.'
      );
    }
  }

  private ensureUserId(): void {
    if (!this.userId) {
      throw new Error('User ID not set. Call setUserId() first.');
    }
  }

  // ============================================
  // PRIVATE: EVENT TRACKING
  // ============================================

  private async trackEventInternal(
    experimentKey: string,
    eventType: EventType,
    options?: {
      eventName?: string;
      eventValue?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    this.ensureInitialized();
    this.ensureUserId();

    const cached = this.assignments.get(experimentKey);
    const variantId = cached?.variantId || '';

    const event: QueuedEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      experimentId: experimentKey,
      variantId,
      userId: this.userId!,
      eventType,
      eventName: options?.eventName || eventType,
      eventValue: options?.eventValue,
      metadata: options?.metadata,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    if (this.eventQueue.length >= this.syncConfig.maxOfflineEvents) {
      this.eventQueue.shift();
    }

    this.eventQueue.push(event);

    if (this.config?.debug) {
      console.log(
        `RiviumAbTesting: Queued ${eventType} event for experiment ${experimentKey}`
      );
    }

    // Auto-flush if batch is full
    if (this.eventQueue.length >= this.syncConfig.maxBatchSize) {
      this.syncEvents().catch(() => {});
    }
  }

  // ============================================
  // PRIVATE: SYNC
  // ============================================

  private startSyncTimer(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(
      () => this.syncEvents().catch(() => {}),
      this.syncConfig.syncIntervalSeconds * 1000
    );
  }

  private async syncEvents(): Promise<void> {
    if (this.isSyncing || this.eventQueue.length === 0) return;

    this.isSyncing = true;

    try {
      const batch = this.eventQueue.slice(0, this.syncConfig.maxBatchSize);

      const response = await fetch(`${API_URL}/public/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
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
          sdkVersion: 'node-0.1.0',
        }),
      });

      if (response.ok) {
        const result = await response.json() as Record<string, unknown>;
        const synced = (result.synced as number) || 0;

        this.eventQueue.splice(0, synced);

        const failed = (result.failed as number) || 0;
        if (failed > 0) {
          for (let i = 0; i < Math.min(failed, this.eventQueue.length); i++) {
            this.eventQueue[i].retryCount++;
            if (this.eventQueue[i].retryCount >= this.syncConfig.maxRetries) {
              this.eventQueue.splice(i, 1);
              i--;
            }
          }
        }

        this.emit('syncCompleted', {
          synced,
          failed,
          pending: this.eventQueue.length,
        });
      }
    } catch (e) {
      this.emit('error', { message: `Sync failed: ${e}` });
    } finally {
      this.isSyncing = false;
    }
  }

  // ============================================
  // PRIVATE: EXPERIMENTS
  // ============================================

  private async fetchExperiments(): Promise<void> {
    try {
      const response = await fetch(
        `${API_URL}/public/init?platform=node&sdkVersion=0.1.0`,
        {
          headers: { 'x-api-key': this.config!.apiKey },
        }
      );

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;

        const experimentsList = (data.experiments as Array<Record<string, unknown>>) || [];
        this.cachedExperiments = experimentsList.map((e) => ({
          id: e.id as string,
          name: e.name as string,
          trafficAllocation: (e.trafficAllocation as number) ?? 100,
          variants: ((e.variants as Array<Record<string, unknown>>) || []).map((v) => ({
            id: v.id as string,
            name: v.name as string,
            config: (v.config as Record<string, unknown>) || undefined,
            isControl: (v.isControl as boolean) ?? false,
            trafficSplit: (v.trafficSplit as number) ?? 50,
          })),
          cachedAt: new Date().toISOString(),
        }));

        if (data.config) {
          this.syncConfig = {
            ...this.syncConfig,
            ...(data.config as Partial<SyncConfig>),
          };
          this.startSyncTimer();
        }

        this.emit('experimentsRefreshed', {
          count: this.cachedExperiments.length,
        });

        if (this.config?.debug) {
          console.log(
            `RiviumAbTesting: Fetched ${this.cachedExperiments.length} experiments`
          );
        }
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to fetch experiments:', e);
      }
      this.emit('error', {
        message: `Failed to fetch experiments: ${e}`,
      });
    }
  }

  // ============================================
  // PRIVATE: LOCAL BUCKETING
  // ============================================

  private getLocalAssignment(
    experimentKey: string,
    defaultVariant: string
  ): string {
    const experiment = this.cachedExperiments.find(
      (e) => e.id === experimentKey
    );
    if (!experiment) return defaultVariant;

    const bucket = this.getBucket(this.userId!, experimentKey);
    if (bucket > experiment.trafficAllocation) {
      const control = experiment.variants.find((v) => v.isControl);
      return control ? control.name : defaultVariant;
    }

    let cumulativeSplit = 0;
    const variantBucket = this.getBucket(
      this.userId!,
      `${experimentKey}:variant`
    );

    for (const variant of experiment.variants) {
      cumulativeSplit += variant.trafficSplit;
      if (variantBucket <= cumulativeSplit) {
        this.assignments.set(experimentKey, {
          experimentId: experimentKey,
          variantId: variant.id,
          variantName: variant.name,
          assignedAt: new Date().toISOString(),
        });

        this.emit('experimentAssigned', {
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
