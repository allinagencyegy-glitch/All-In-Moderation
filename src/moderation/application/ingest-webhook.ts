import type { AccountRepository } from '../../core/account/index.ts';
import { canIngest, scopeForAccount, scopedPartitionKey } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import type { IdFactory, RawInboundEventId, TraceId } from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import { sha256Hex } from '../../platform/hash.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { JobQueue } from '../../operations/jobs/queue.ts';
import type { WebhookSignatureVerifier } from '../domain/inbound.ts';
import type { RawInboundEvent } from '../domain/raw-event.ts';
import type {
  ChannelConnectionRepository,
  RawInboundEventRepository,
  SecretResolver,
} from '../ports.ts';

/**
 * Webhook ingestion: **persist first, process second** (ADR-006).
 *
 * The ordering in `ingest` is the load-bearing part of this file:
 *
 *   1. Resolve the connection from the opaque URL id  -> the account is known before parsing
 *   2. Enforce the size cap
 *   3. Verify the signature over the raw bytes
 *   4. Hash the body for delivery-level deduplication
 *   5. In ONE transaction: insert the ledger row and enqueue the normalize job
 *   6. Only then acknowledge
 *
 * There is no path from here to a language model, to the knowledge base, or to any interpretation
 * of the payload. The module boundary test enforces that. The provider's timeout must never
 * become our model's timeout.
 */

export interface IngestRequest {
  readonly publicWebhookId: string;
  /** The verbatim body. Signature verification is meaningless against a re-serialised object. */
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type IngestOutcome =
  | {
      readonly status: 'ACCEPTED';
      readonly rawEventId: RawInboundEventId;
      readonly httpStatus: 200;
    }
  | {
      readonly status: 'DUPLICATE';
      readonly rawEventId: RawInboundEventId;
      readonly httpStatus: 200;
    }
  | {
      readonly status: 'REJECTED_SIGNATURE';
      readonly rawEventId: RawInboundEventId | null;
      readonly httpStatus: 200;
    }
  | { readonly status: 'UNKNOWN_CONNECTION'; readonly httpStatus: 404 }
  | { readonly status: 'CONNECTION_DISABLED'; readonly httpStatus: 200 }
  | { readonly status: 'PAYLOAD_TOO_LARGE'; readonly httpStatus: 413 };

export interface IngestConfig {
  readonly maxBodyBytes: number;
  readonly normalizeMaxAttempts: number;
}

export const DEFAULT_INGEST_CONFIG: IngestConfig = {
  maxBodyBytes: 1_000_000,
  normalizeMaxAttempts: 5,
};

export interface IngestWebhookDeps {
  readonly connections: ChannelConnectionRepository;
  readonly accounts: AccountRepository;
  readonly rawEvents: RawInboundEventRepository;
  readonly secrets: SecretResolver;
  /** Injected per channel: every provider signs differently (ADR-006). */
  readonly signatures: WebhookSignatureVerifier;
  readonly queue: JobQueue;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly config?: IngestConfig;
}

export interface IngestWebhookService {
  ingest(request: IngestRequest): Promise<IngestOutcome>;
}

export function createIngestWebhookService(deps: IngestWebhookDeps): IngestWebhookService {
  const config = deps.config ?? DEFAULT_INGEST_CONFIG;

  return {
    async ingest(request) {
      const connection = await deps.connections.findByPublicWebhookId(request.publicWebhookId);
      if (!connection) {
        // No tenant to attribute this to, so there is nowhere safe to store it. Counted and
        // logged; a sustained rate here means a stale or leaked webhook URL.
        deps.logger.warn('webhook for unknown connection', {
          public_webhook_id: request.publicWebhookId,
        });
        return { status: 'UNKNOWN_CONNECTION', httpStatus: 404 };
      }

      const logger = deps.logger.child({
        account_id: connection.accountId,
        channel_connection_id: connection.id,
        channel: connection.channel,
      });

      if (Buffer.byteLength(request.rawBody, 'utf8') > config.maxBodyBytes) {
        logger.warn('webhook body exceeded size cap');
        return { status: 'PAYLOAD_TOO_LARGE', httpStatus: 413 };
      }

      const account = await deps.accounts.findById(connection.accountId);
      if (!account || !canIngest(account)) {
        // An archived account is the only case where we decline to store. A *suspended* account
        // still ingests: dropping a suspended client's messages would be silent data loss.
        logger.warn('ingest declined for account state', {
          account_status: account?.status ?? 'MISSING',
        });
        return { status: 'CONNECTION_DISABLED', httpStatus: 200 };
      }
      const scope = scopeForAccount(account);

      if (connection.status === 'DISABLED') {
        logger.warn('ingest declined for disabled connection');
        return { status: 'CONNECTION_DISABLED', httpStatus: 200 };
      }

      const secret = await deps.secrets.resolve(connection.credentialsRef);
      const signature = deps.signatures.verify({
        rawBody: request.rawBody,
        headers: request.headers,
        appSecret: secret?.appSecret ?? '',
      });

      const deliveryKey = sha256Hex(request.rawBody);
      const traceId = deps.ids.next<TraceId>(ID_PREFIX.trace);
      const now = deps.clock.now();

      const candidate: RawInboundEvent = {
        id: deps.ids.next<RawInboundEventId>(ID_PREFIX.rawInboundEvent),
        accountId: scope.accountId,
        channelConnectionId: connection.id,
        deliveryKey,
        payload: safeParse(request.rawBody),
        headers: stripSecretHeaders(request.headers),
        signatureValid: signature.valid,
        state: signature.valid ? 'RECEIVED' : 'REJECTED',
        receivedAt: now,
        normalizedAt: null,
        producedMessageIds: [],
        error: signature.valid
          ? null
          : { code: 'SIGNATURE_INVALID', message: `signature ${signature.reason.toLowerCase()}` },
        traceId,
      };

      // One transaction: the ledger row and the promise to process it commit together, or neither
      // does. This is the entire reason the queue lives in the same database (ADR-004).
      return await deps.transactions.run(async () => {
        const result = await deps.rawEvents.insertIfNew(scope, candidate);

        if (!result.inserted) {
          logger.info('duplicate webhook delivery', { raw_event_id: result.record.id });
          return { status: 'DUPLICATE', rawEventId: result.record.id, httpStatus: 200 };
        }

        if (!signature.valid) {
          // Stored for forensics — a misconfigured secret and a genuine spoof are indistinguishable
          // without evidence — but never normalised, and subject to a short retention window.
          logger.warn('webhook signature rejected', {
            raw_event_id: result.record.id,
            reason: signature.reason,
          });
          return { status: 'REJECTED_SIGNATURE', rawEventId: result.record.id, httpStatus: 200 };
        }

        await deps.queue.enqueue({
          accountId: scope.accountId,
          type: 'raw_event.normalize',
          // Normalisation is serialised per connection so events become messages in arrival
          // order; this is what preserves per-conversation ordering upstream of the moderator.
          partitionKey: scopedPartitionKey(scope, 'conn', connection.id),
          payload: { rawEventId: result.record.id },
          runAt: now,
          maxAttempts: config.normalizeMaxAttempts,
          traceId,
        });

        logger.info('webhook accepted', { raw_event_id: result.record.id });
        return { status: 'ACCEPTED', rawEventId: result.record.id, httpStatus: 200 };
      });
    },
  };
}

/**
 * Stores the body as parsed JSON when possible, and as a raw string otherwise.
 *
 * A body we cannot parse is still evidence: it is the only way to diagnose a provider change or a
 * malformed delivery after the fact, so it is never discarded.
 */
function safeParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return { __unparsed: rawBody };
  }
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

function stripSecretHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}
