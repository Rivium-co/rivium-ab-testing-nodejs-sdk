/** Test helpers: a fake service in place of fetch. */

export interface Call {
  path: string;
  secret?: string;
  body: any;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Route = Reply | Error | ((call: Call) => Reply | Error);

const USER_ROUTES = ['/public/assign', '/public/sync', '/public/flag-evaluation'];

export class FakeService {
  calls: Call[] = [];
  routes: Record<string, Route> = {
    '/public/init': { body: { experiments: [] } },
    '/public/flags': { body: { flags: [] } },
    '/public/assign': (call) => assigned(`for-${call.body.userId}`),
    '/public/sync': (call) => ({ body: { success: true, synced: call.body.events.length, failed: 0 } }),
  };

  install(): void {
    (globalThis as any).fetch = jest.fn(async (url: string, init: any = {}) => {
      const path = new URL(url).pathname;
      const call: Call = {
        path,
        secret: init.headers?.['x-server-secret'],
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      this.calls.push(call);

      const route = this.routes[path];
      const reply = typeof route === 'function' ? route(call) : route;
      if (reply instanceof Error) throw reply;
      if (!reply) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: reply.headers,
      });
    });
  }

  to(path: string): Call[] {
    return this.calls.filter((c) => c.path === path);
  }

  /** Calls that act for a user (and so need the server secret). */
  userCalls(): Call[] {
    return this.calls.filter((c) => USER_ROUTES.includes(c.path));
  }

  sentEvents(): { userId: string; id: string; eventName: string }[] {
    return this.to('/public/sync').flatMap((c) =>
      c.body.events.map((e: any) => ({ userId: e.userId, id: e.clientEventId, eventName: e.eventName }))
    );
  }
}

export function assigned(variantName: string, extra: Record<string, unknown> = {}): Reply {
  return {
    body: {
      data: {
        experimentId: 'exp-1',
        experimentKey: 'checkout',
        variantId: `id-${variantName}`,
        variantKey: variantName,
        variantName,
        config: { color: variantName },
        isControl: false,
        inExperiment: true,
        ...extra,
      },
    },
  };
}

export function unauthorized(code: string): Reply {
  return { status: 401, body: { statusCode: 401, error: 'Unauthorized', code, message: code } };
}

/** Lets promises that are already on their way settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}
