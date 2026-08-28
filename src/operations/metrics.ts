/**
 * Inbound transport counters.
 *
 * Objective 12 asks for accepted/rejected counts, invalid signatures, duplicates, unsupported
 * event types and per-channel receive status. Most of those are not answerable from the database:
 * a duplicate delivery writes no row *by design* (that is what makes it a duplicate), and a
 * webhook for an unknown connection has no tenant to file it under. If they are not counted in
 * process, they are not counted at all.
 *
 * Three rules make this safe to expose on the least-authenticated surface in the system:
 *
 *   1. **Labels are a closed vocabulary.** A label value is a channel, an outcome or a
 *      classification — all of them enumerations declared in this repository. No account id, no
 *      page id, no webhook id, no customer content ever becomes a label, which is also what stops
 *      an attacker turning a counter map into an unbounded allocation by varying an input.
 *   2. **Counts only.** No timestamps of individual events, no last-seen identifiers. "Which
 *      connection last received something" is a per-tenant question and belongs to the operator
 *      CLI, which authenticates against the database.
 *   3. **Monotonic and process-local.** These reset when the process does. They are a health
 *      signal, not an audit trail; the ledger is the audit trail.
 */

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsRegistry {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** Counter values keyed `name` or `name{label=value,...}`, label names sorted. */
  snapshot(): Readonly<Record<string, number>>;
  /** Totals for one metric, grouped by a single label. The shape a dashboard actually wants. */
  groupBy(name: string, label: string): Readonly<Record<string, number>>;
  reset(): void;
}

/**
 * The label characters a value may contain.
 *
 * Anything else is replaced rather than rejected: a metric that throws is a metric that can take
 * down the path it was measuring, and the whole point of a counter is that it never becomes the
 * reason a webhook failed.
 */
const LABEL_SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;

const sanitise = (value: string): string => (LABEL_SAFE.test(value) ? value : 'invalid');

function keyFor(name: string, labels: MetricLabels | undefined): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${sanitise(labels[label] ?? '')}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}

/**
 * A ceiling on distinct series.
 *
 * Belt and braces beside the closed label vocabulary: if a future caller ever does pass something
 * unbounded, the registry stops growing instead of becoming the memory leak. Overflow is counted
 * under its own series so the truncation is visible rather than silent.
 */
const MAX_SERIES = 512;

export function createMetricsRegistry(): MetricsRegistry {
  let counters = new Map<string, number>();

  return {
    increment(name, labels, by = 1) {
      const key = keyFor(name, labels);
      const existing = counters.get(key);
      if (existing === undefined && counters.size >= MAX_SERIES) {
        counters.set('metrics.series_overflow', (counters.get('metrics.series_overflow') ?? 0) + 1);
        return;
      }
      counters.set(key, (existing ?? 0) + by);
    },

    snapshot() {
      return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },

    groupBy(name, label) {
      const prefix = `${name}{`;
      const pattern = new RegExp(`(?:^|,)${label}=([^,}]*)`);
      const out: Record<string, number> = {};
      for (const [key, value] of counters) {
        if (!key.startsWith(prefix)) continue;
        const match = pattern.exec(key.slice(prefix.length, -1));
        if (!match) continue;
        const bucket = match[1] ?? 'unknown';
        out[bucket] = (out[bucket] ?? 0) + value;
      }
      return out;
    },

    reset() {
      counters = new Map();
    },
  };
}

/** The metric names this phase emits, so a typo is a compile error rather than a missing chart. */
export const TRANSPORT_METRICS = {
  /** One per webhook POST that resolved to a connection. Labelled by channel and outcome. */
  webhookDelivery: 'transport.webhook_delivery',
  /** One per POST that could not be attributed to any connection. Labelled by nothing. */
  webhookUnknownConnection: 'transport.webhook_unknown_connection',
  /** Signature failures, labelled by reason. A spike here is a rotated secret or a prober. */
  webhookSignatureRejected: 'transport.webhook_signature_rejected',
  /** Subscription handshakes, labelled by outcome. */
  subscriptionVerification: 'transport.subscription_verification',
  /** One per parsed inbound item, labelled by channel and classification. */
  inboundItem: 'transport.inbound_item',
  /** Items refused because no connection identity owned them. The misrouting alarm. */
  inboundUnroutable: 'transport.inbound_unroutable',
  /** Items on a surface the client has not enabled. */
  inboundSurfaceDisabled: 'transport.inbound_surface_disabled',
  /** Item-level duplicates: the same message inside a different envelope. */
  inboundDuplicateItem: 'transport.inbound_duplicate_item',
} as const;

/** The shape published on `/health/status`. Aggregates only — see rule 2 above. */
export interface TransportSnapshot {
  readonly deliveries: Readonly<Record<string, number>>;
  readonly deliveriesByChannel: Readonly<Record<string, number>>;
  readonly unknownConnection: number;
  readonly signatureRejected: Readonly<Record<string, number>>;
  readonly subscriptionVerification: Readonly<Record<string, number>>;
  readonly itemsByClassification: Readonly<Record<string, number>>;
  readonly itemsByChannel: Readonly<Record<string, number>>;
  readonly unroutableItems: number;
  readonly surfaceDisabledItems: number;
  readonly duplicateItems: number;
}

const total = (grouped: Readonly<Record<string, number>>): number =>
  Object.values(grouped).reduce((sum, value) => sum + value, 0);

export function transportSnapshot(metrics: MetricsRegistry): TransportSnapshot {
  const snapshot = metrics.snapshot();
  return {
    deliveries: metrics.groupBy(TRANSPORT_METRICS.webhookDelivery, 'outcome'),
    deliveriesByChannel: metrics.groupBy(TRANSPORT_METRICS.webhookDelivery, 'channel'),
    unknownConnection: snapshot[TRANSPORT_METRICS.webhookUnknownConnection] ?? 0,
    signatureRejected: metrics.groupBy(TRANSPORT_METRICS.webhookSignatureRejected, 'reason'),
    subscriptionVerification: metrics.groupBy(
      TRANSPORT_METRICS.subscriptionVerification,
      'outcome',
    ),
    itemsByClassification: metrics.groupBy(TRANSPORT_METRICS.inboundItem, 'classification'),
    itemsByChannel: metrics.groupBy(TRANSPORT_METRICS.inboundItem, 'channel'),
    unroutableItems: total(metrics.groupBy(TRANSPORT_METRICS.inboundUnroutable, 'channel')),
    surfaceDisabledItems: total(
      metrics.groupBy(TRANSPORT_METRICS.inboundSurfaceDisabled, 'channel'),
    ),
    duplicateItems: total(metrics.groupBy(TRANSPORT_METRICS.inboundDuplicateItem, 'channel')),
  };
}
