import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import { describeError } from '../../platform/errors.ts';
import type { HealthService } from '../../operations/health.ts';
import type { IngestWebhookService } from '../../moderation/application/ingest-webhook.ts';
import { decodeExactUtf8, readRawBody } from './raw-body.ts';

/**
 * The HTTP edge.
 *
 * It is deliberately thin. Everything it does is translate: a URL into a webhook id, a query
 * string into a verification request, bytes into an ingest request, a domain outcome into a
 * status code. It makes no decisions of its own, holds no state, and cannot reach a model — the
 * module boundary test enforces the last of those for the ingest service it calls.
 *
 * Four properties are the reason this file exists at all, and each is a way the webhook contract
 * is usually broken:
 *
 *   1. **Persist first, process second.** The response is written after the ledger row and the
 *      job commit, and before any of that work runs. A provider's webhook timeout is a few
 *      seconds; a model call is not. Anything interpretive on this path would eventually turn
 *      their timeout into our outage (ADR-006, invariant I1).
 *   2. **Raw bytes, verbatim.** No parser runs before verification. See `raw-body.ts`.
 *   3. **A cap that is enforced while reading**, not after. A limit checked once the body is in
 *      memory is not a limit.
 *   4. **Health without the database, and health with it.** Liveness must not fail because
 *      PostgreSQL hiccuped, or an orchestrator will restart every healthy process during a
 *      failover and turn a degradation into an outage.
 */

export interface HttpServer {
  /** Resolves once the socket is bound. Returns the actual port — ephemeral ports resolve here. */
  start(): Promise<{ port: number; host: string }>;
  stop(graceMs: number): Promise<void>;
  readonly address: () => { port: number; host: string } | null;
  readonly stats: () => { requests: number; inFlight: number };
}

export interface HttpServerOptions {
  readonly port: number;
  readonly host: string;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxBodyBytes: number;
}

/** The only channel with a registered adapter in this phase. */
const WEBHOOK_ROUTE = /^\/webhooks\/meta\/([A-Za-z0-9._~-]{1,128})$/;

interface Json {
  readonly [key: string]: unknown;
}

export function createHttpServer(deps: {
  ingest: IngestWebhookService;
  health: HealthService;
  clock: Clock;
  logger: Logger;
  options: HttpServerOptions;
}): HttpServer {
  const { options } = deps;
  const logger = deps.logger.child({ component: 'http' });
  let requests = 0;
  let inFlight = 0;

  const send = (res: ServerResponse, status: number, body: Json | string): void => {
    const isText = typeof body === 'string';
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload, 'utf8'),
      // This surface answers machines, not browsers. Nothing here should ever be cached, sniffed
      // or embedded.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
  };

  /**
   * Header values, flattened.
   *
   * `node:http` lower-cases names and may hand back an array for repeated headers. A repeated
   * `x-hub-signature-256` is not something a legitimate sender does, and joining the values
   * guarantees the verifier sees something that cannot match rather than silently accepting the
   * first one.
   */
  const flattenHeaders = (req: IncomingMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      out[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
  };

  const handleVerification = async (
    res: ServerResponse,
    publicWebhookId: string,
    query: URLSearchParams,
  ): Promise<number> => {
    const outcome = await deps.ingest.verifySubscription({
      publicWebhookId,
      mode: query.get('hub.mode'),
      verifyToken: query.get('hub.verify_token'),
      challenge: query.get('hub.challenge'),
    });
    if (outcome.status === 'VERIFIED') {
      // Echoed as plain text, verbatim. The provider compares the body byte for byte, so a JSON
      // wrapper here would fail the handshake in a way that looks like a network problem.
      send(res, 200, outcome.challenge);
      return 200;
    }
    // The reason is logged inside the domain service and deliberately not returned: telling an
    // unauthenticated caller *why* its token was refused is free reconnaissance.
    send(res, outcome.httpStatus, { status: outcome.status });
    return outcome.httpStatus;
  };

  const handleIngest = async (
    req: IncomingMessage,
    res: ServerResponse,
    publicWebhookId: string,
  ): Promise<number> => {
    const body = await readRawBody(req, options.maxBodyBytes);

    if (!body.ok) {
      if (body.reason === 'ABORTED') {
        // The client went away. There is nobody to answer, and the provider will redeliver.
        res.destroy();
        return 499;
      }
      logger.warn('webhook body exceeded the cap', {
        public_webhook_id: publicWebhookId,
        max_body_bytes: options.maxBodyBytes,
        hard_stopped: body.hardStopped,
      });
      if (body.hardStopped) return 413;
      send(res, 413, { status: 'PAYLOAD_TOO_LARGE' });
      return 413;
    }

    const rawBody = decodeExactUtf8(body.bytes);
    if (rawBody === null) {
      // Refused rather than repaired. A lossy decode would hand the verifier bytes the sender
      // never sent, and the signature failure would be unexplainable from either side.
      logger.warn('webhook body was not valid utf-8', { public_webhook_id: publicWebhookId });
      send(res, 400, { status: 'MALFORMED_BODY' });
      return 400;
    }

    const outcome = await deps.ingest.ingest({
      publicWebhookId,
      rawBody,
      headers: flattenHeaders(req),
    });
    // The status comes from the domain, not from this file. An invalid signature answers 200 on
    // purpose (ADR-006): the event is stored for forensics and must never be redelivered, and a
    // 4xx would tell a prober which secret it guessed wrong.
    send(res, outcome.httpStatus, { status: outcome.status });
    return outcome.httpStatus;
  };

  const handleHealth = async (res: ServerResponse, path: string): Promise<number> => {
    if (path === '/health/live') {
      // No database call, by design. Liveness answers "is this process running?" — nothing else.
      const live = deps.health.liveness();
      send(res, 200, { status: 'ALIVE', ...live });
      return 200;
    }

    const snapshot = await deps.health.snapshot();
    if (path === '/health/ready') {
      // DEGRADED still serves traffic: a dead letter or a slow queue is a reason to page someone,
      // not a reason to remove the only process that can work through the backlog.
      const ready = snapshot.status !== 'DOWN' && !snapshot.process.shuttingDown;
      send(res, ready ? 200 : 503, {
        status: snapshot.status,
        ready,
        shuttingDown: snapshot.process.shuttingDown,
        reasons: snapshot.reasons,
      });
      return ready ? 200 : 503;
    }

    send(res, snapshot.status === 'DOWN' ? 503 : 200, {
      ...snapshot,
      checkedAt: snapshot.checkedAt.toISOString(),
      inbound: { ...snapshot.inbound, oldestAt: snapshot.inbound.oldestAt?.toISOString() ?? null },
      outbox: { ...snapshot.outbox, oldestAt: snapshot.outbox.oldestAt?.toISOString() ?? null },
    });
    return snapshot.status === 'DOWN' ? 503 : 200;
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    // A base is required to parse a path-only URL; it is never used for anything else, so it
    // cannot be influenced by a Host header.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path.startsWith('/health/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, { status: 'METHOD_NOT_ALLOWED' });
        return 405;
      }
      if (path !== '/health/live' && path !== '/health/ready' && path !== '/health/status') {
        send(res, 404, { status: 'NOT_FOUND' });
        return 404;
      }
      return await handleHealth(res, path);
    }

    const match = WEBHOOK_ROUTE.exec(path);
    if (!match) {
      send(res, 404, { status: 'NOT_FOUND' });
      return 404;
    }
    const publicWebhookId = match[1]!;

    if (method === 'GET') return await handleVerification(res, publicWebhookId, url.searchParams);
    if (method === 'POST') return await handleIngest(req, res, publicWebhookId);

    send(res, 405, { status: 'METHOD_NOT_ALLOWED' });
    return 405;
  };

  const server: Server = createServer((req, res) => {
    requests += 1;
    inFlight += 1;
    const startedAt = Date.now();
    void route(req, res)
      .catch((error: unknown) => {
        const described = describeError(error);
        // The response body says nothing beyond the code. Error text routinely contains query
        // parameters, and query parameters routinely contain customer content.
        logger.error('unhandled request failure', {
          method: req.method ?? null,
          code: described.code,
          message: described.message,
        });
        if (!res.headersSent) send(res, 500, { status: 'INTERNAL_ERROR' });
        else res.destroy();
        return 500;
      })
      .then((status) => {
        logger.debug('request', {
          method: req.method ?? null,
          // The path carries the opaque webhook id, which is a credential of sorts. Only the
          // route shape is logged.
          route: req.url?.startsWith('/webhooks/') === true ? '/webhooks/meta/:id' : req.url,
          status: status ?? 0,
          duration_ms: Date.now() - startedAt,
        });
      })
      .finally(() => {
        inFlight -= 1;
      });
  });

  // Slow-loris bounds. Without these a handful of connections that dribble headers forever can
  // hold the listener open indefinitely.
  server.headersTimeout = options.headersTimeoutMs;
  server.requestTimeout = options.requestTimeoutMs;
  // `keepAliveTimeout` must stay below `headersTimeout` or Node warns; leaving Node's default
  // (5s) is correct for a webhook receiver, which sees short bursts rather than long sessions.

  const address = (): { port: number; host: string } | null => {
    const info = server.address();
    if (info === null || typeof info === 'string') return null;
    const { port, address: host } = info;
    return { port, host };
  };

  return {
    address,
    stats: () => ({ requests, inFlight }),

    start() {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const bound = address();
          if (!bound) {
            reject(new Error('server reported no address after listening'));
            return;
          }
          logger.info('http server listening', { port: bound.port, host: bound.host });
          resolve(bound);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.host);
      });
    },

    async stop(graceMs) {
      if (!server.listening) return;
      const closed = new Promise<void>((resolve) => {
        // `close` stops accepting new connections and resolves once in-flight requests finish.
        server.close(() => {
          resolve();
        });
      });
      // Idle keep-alive sockets hold `close` open forever otherwise: they are connections with no
      // request on them, so nothing will ever finish and release them.
      server.closeIdleConnections();

      let timer: NodeJS.Timeout | null = null;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, graceMs);
      });
      const outcome = await Promise.race([closed.then(() => 'closed' as const), deadline]);
      if (timer) clearTimeout(timer);

      if (outcome === 'timeout') {
        logger.warn('http shutdown grace expired; closing remaining connections', {
          grace_ms: graceMs,
          in_flight: inFlight,
        });
        server.closeAllConnections();
        await closed;
      }
      logger.info('http server stopped', { requests });
    },
  };
}
