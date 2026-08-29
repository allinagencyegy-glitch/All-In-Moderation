import { readFileSync } from 'node:fs';
import { TerminalError } from '../../platform/errors.ts';
import { hashJson } from '../../platform/hash.ts';
import { asId } from '../../platform/ids.ts';
import type {
  AccountId,
  AccountPackVersionId,
  KnowledgeEntryId,
  UserId,
} from '../../platform/ids.ts';
import * as s from '../../platform/schema.ts';
import { normalizeTags } from '../../platform/text/normalize-arabic.ts';
import type { AccountPackVersion, PackSectionKey } from '../../knowledge/domain/account-pack.ts';
import { PACK_SCHEMA_VERSION, validatePack } from '../../knowledge/domain/account-pack.ts';
import type { KnowledgeEntry } from '../../knowledge/domain/knowledge-entry.ts';
import { COMMERCIAL_KINDS, KNOWLEDGE_KINDS } from '../../knowledge/domain/knowledge-entry.ts';

/**
 * Authoring Account Packs and knowledge entries from files on disk.
 *
 * Before this existed, the only code that built a pack was `demo.ts` and the shadow-acceptance
 * self-test, both of which construct one inline. That was fine while every pack was synthetic and
 * fine for exactly as long as it took to onboard a real client: client content is *data* (ADR-010,
 * and `module-boundaries.test.ts` asserts no client identifier appears in `src/`), so there has to
 * be a way to get data in that is not "write it into a TypeScript file".
 *
 * Two rules are enforced here rather than left to whoever runs the command:
 *
 *   1. **Approval is explicit and attributed.** An entry is DRAFT unless `--approve` is passed
 *      with an approver. There is no field in the file that can mark something approved.
 *   2. **A commercial claim needs an expiry.** A PRICE or an OFFER cannot be approved without a
 *      `validUntil`. The database enforces the same rule independently
 *      (`knowledge_commercial_requires_expiry`, migration 0004); this check exists so the refusal
 *      arrives with a sentence an operator can act on instead of a constraint name.
 */

// --- pack ---------------------------------------------------------------------------------------

const packFileSchema = s.object({
  accountSlug: s.optional(s.string({ maxLength: 64 })),
  schemaVersion: s.optional(s.string({ maxLength: 32 })),
  notes: s.optional(s.string({ maxLength: 2000 })),
  sections: s.record(s.jsonValue(), { maxEntries: 64 }),
});

export interface LoadPackOptions {
  readonly accountId: AccountId;
  readonly version: number;
  readonly publishedBy: UserId;
  readonly now: Date;
  readonly packId?: AccountPackVersionId;
  readonly status?: AccountPackVersion['status'];
}

/**
 * Reads a pack file and returns a validated, content-hashed version.
 *
 * Throws with every issue at once rather than the first: an operator fixing a pack wants the list,
 * not a sequence of round trips.
 */
export function loadPackFile(path: string, options: LoadPackOptions): AccountPackVersion {
  const parsed = parseJsonFile(path);
  const issues = s.validate(packFileSchema, parsed);
  if (issues.length > 0) {
    throw new TerminalError('PACK_FILE_INVALID', `${path}: ${s.formatIssues(issues, 20)}`);
  }
  const file = parsed as s.Infer<typeof packFileSchema>;
  const sections = file.sections as Readonly<Partial<Record<PackSectionKey, unknown>>>;

  const pack: AccountPackVersion = {
    id: options.packId ?? asId<AccountPackVersionId>(`apv_${String(options.version)}`),
    accountId: options.accountId,
    version: options.version,
    status: options.status ?? 'ACTIVE',
    contentHash: hashJson(sections),
    sections,
    publishedBy: options.publishedBy,
    publishedAt: options.now,
    schemaVersion: file.schemaVersion ?? PACK_SCHEMA_VERSION,
    notes: file.notes ?? null,
  };

  const packIssues = validatePack(pack);
  if (packIssues.length > 0) {
    throw new TerminalError('PACK_INVALID', `${path}: ${s.formatIssues(packIssues, 20)}`);
  }
  return pack;
}

// --- knowledge ----------------------------------------------------------------------------------

const moneySchema = s.object({
  amount: s.string({ minLength: 1, maxLength: 32 }),
  currency: s.string({ minLength: 3, maxLength: 3 }),
});

const entrySchema = s.object({
  key: s.string({ minLength: 1, maxLength: 64, pattern: /^[a-z0-9-]+$/ }),
  kind: s.enumOf(KNOWLEDGE_KINDS),
  title: s.string({ minLength: 1, maxLength: 200 }),
  body: s.string({ minLength: 1, maxLength: 4000 }),
  locale: s.optional(s.string({ maxLength: 16 })),
  tags: s.array(s.string({ minLength: 1, maxLength: 64 }), { maxItems: 40 }),
  intentCodes: s.array(s.string({ minLength: 1, maxLength: 64 }), { maxItems: 40 }),
  productRef: s.optional(s.string({ maxLength: 64 })),
  paymentType: s.optional(s.string({ maxLength: 32 })),
  price: s.optional(moneySchema),
  validFrom: s.optional(s.string({ maxLength: 40 })),
  validUntil: s.optional(s.string({ maxLength: 40 })),
  /** The workbook's five-level grade, carried through so provenance survives the import. */
  dataConfidence: s.string({ minLength: 1, maxLength: 64 }),
  sourceCells: s.string({ minLength: 1, maxLength: 500 }),
  evidence: s.string({ minLength: 1, maxLength: 2000 }),
  /** DRAFT-only annotations. Present in the draft file, meaningless once approved. */
  blockedBy: s.optional(s.string({ maxLength: 500 })),
  requiresConfirmation: s.optional(s.array(s.string({ maxLength: 200 }), { maxItems: 20 })),
});

const knowledgeFileSchema = s.object({
  note: s.optional(s.string({ maxLength: 2000 })),
  locale: s.string({ minLength: 2, maxLength: 16 }),
  entries: s.array(entrySchema, { maxItems: 500 }),
});

export type KnowledgeFileEntry = s.Infer<typeof entrySchema>;

export interface LoadKnowledgeOptions {
  readonly accountId: AccountId;
  readonly now: Date;
  /** Without this every entry is DRAFT, and a DRAFT entry is invisible to the model. */
  readonly approve?: { readonly approver: UserId };
}

export interface LoadedKnowledge {
  readonly entries: readonly KnowledgeEntry[];
  readonly approved: number;
  readonly draft: number;
}

export function loadKnowledgeFile(path: string, options: LoadKnowledgeOptions): LoadedKnowledge {
  const parsed = parseJsonFile(path);
  const issues = s.validate(knowledgeFileSchema, parsed);
  if (issues.length > 0) {
    throw new TerminalError('KNOWLEDGE_FILE_INVALID', `${path}: ${s.formatIssues(issues, 20)}`);
  }
  const file = parsed as s.Infer<typeof knowledgeFileSchema>;

  const entries: KnowledgeEntry[] = [];
  for (const raw of file.entries) {
    const validUntil = raw.validUntil ? parseDate(raw.validUntil, `${raw.key}.validUntil`) : null;

    if (options.approve && COMMERCIAL_KINDS.has(raw.kind) && validUntil === null) {
      // Refused here *and* by the database. A price or an offer with no end date is the failure
      // that presents last spring's promotion as current, and it is not worked around.
      throw new TerminalError(
        'KNOWLEDGE_COMMERCIAL_NEEDS_EXPIRY',
        `'${raw.key}' is a ${raw.kind} and cannot be approved without validUntil. ` +
          'Obtain the expiry from the client; do not remove the constraint.',
        { key: raw.key, kind: raw.kind },
      );
    }

    entries.push({
      id: asId<KnowledgeEntryId>(`kne_${raw.key}`),
      accountId: options.accountId,
      kind: raw.kind,
      title: raw.title,
      body: raw.body,
      locale: raw.locale ?? file.locale,
      status: options.approve ? 'APPROVED' : 'DRAFT',
      validFrom: raw.validFrom ? parseDate(raw.validFrom, `${raw.key}.validFrom`) : null,
      validUntil,
      sourceRef: raw.sourceCells,
      // Provenance and confidence travel together into the one free-text column the schema has.
      // A reviewer reading a row must be able to see how good the evidence was, not just what it
      // said.
      evidence: `[${raw.dataConfidence}] ${raw.evidence}`,
      approvedBy: options.approve?.approver ?? null,
      approvedAt: options.approve ? options.now : null,
      productRef: raw.productRef ?? null,
      paymentType: raw.paymentType ?? null,
      price: raw.price ? { amount: raw.price.amount, currency: raw.price.currency } : null,
      // Normalised on the way in, with the same function retrieval uses on the way out. Authoring
      // a tag as `كرسي أسنان` and matching a customer who typed `الكرسي` only works because both
      // sides are folded identically — see `platform/text/normalize-arabic.ts`.
      tags: normalizeTags(raw.tags),
      intentCodes: [...raw.intentCodes],
      supersedesId: null,
      updatedAt: options.now,
    });
  }

  return {
    entries,
    approved: options.approve ? entries.length : 0,
    draft: options.approve ? 0 : entries.length,
  };
}

// --- shared -------------------------------------------------------------------------------------

function parseJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new TerminalError('FILE_UNREADABLE', `cannot read ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TerminalError(
      'FILE_NOT_JSON',
      `${path} is not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TerminalError('DATE_INVALID', `${field}: '${value}' is not a date`);
  }
  return parsed;
}
