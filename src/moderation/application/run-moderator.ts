import type { AccountRepository } from '../../core/account/index.ts';
import { canActAutonomously, scopedPartitionKey } from '../../core/account/index.ts';
import type { AccountScope } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import { ConcurrencyConflictError, TerminalError } from '../../platform/errors.ts';
import type {
  ConversationId,
  DomainEventId,
  HandoffId,
  IdFactory,
  ModeratorRunId,
  OutboundActionId,
  TraceId,
} from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import { tokenize } from '../../platform/text/normalize-arabic.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { JobQueue } from '../../operations/jobs/queue.ts';
import type { AuditLog } from '../../operations/audit.ts';
import type { EventOutbox } from '../../operations/events/outbox.ts';
import { assertPublishable } from '../../operations/events/outbox.ts';
import type { LlmProvider, ModelResolver } from '../../platform/llm/provider.ts';
import { completeStructured } from '../../platform/llm/structured.ts';
import type { KnowledgeGate } from '../../knowledge/application/knowledge-gate.ts';
import type { KnowledgeCandidateSet } from '../../knowledge/application/knowledge-gate.ts';
import type { AccountPackRepository, KnowledgeGapRepository } from '../../knowledge/ports.ts';
import { gateAction, fallbackActionFor } from '../../policy/action-gate.ts';
import type { ActionGateInput, AuthorizedAction } from '../../policy/action-gate.ts';
import { ACTION_RISK, ACTION_TYPES } from '../../policy/actions.ts';
import type { ActionType } from '../../policy/actions.ts';
import type { Conversation } from '../domain/conversation.ts';
import {
  hasUnprocessedInbound,
  mayActAutonomously,
  transitionOwnership,
} from '../domain/conversation.ts';
import type { ModeratorDecisionProposal, PolicyOutcome } from '../domain/decision.ts';
import { moderatorDecisionSchema } from '../domain/decision.ts';
import type { Handoff } from '../domain/handoff.ts';
import type { ModeratorRun, SkipReason } from '../domain/moderator-run.ts';
import { checkStalenessGuard, transitionRun } from '../domain/moderator-run.ts';
import type { OutboundActionPayload } from '../domain/outbound-action.ts';
import { createOutboundAction } from '../domain/outbound-action.ts';
import { isReceiveOnly } from '../domain/channel.ts';
import type {
  ChannelConnectionRepository,
  ConversationRepository,
  HandoffRepository,
  MessageRepository,
  ModeratorRunRepository,
  OutboundActionRepository,
} from '../ports.ts';
import { buildModeratorRequest, MODERATOR_PROMPT_VERSION } from './prompt.ts';
import {
  resolveAuthorityMatrix,
  resolveBrandVoice,
  resolveEscalationPolicy,
  resolveIntentTaxonomy,
  resolveRoutingPolicy,
} from './routing-policy.ts';

/**
 * The moderator run: the one place where a probabilistic component influences customer-facing
 * behaviour, and therefore the place with the most guard rails.
 *
 * The pipeline, in order, is the architecture:
 *
 *   deterministic admission checks   (ownership, lifecycle, account, pack, unprocessed input)
 *        -> knowledge retrieval      (approved + in-validity only; the model never sees anything else)
 *        -> LLM structured proposal  (no tools, no side effects, closed action vocabulary)
 *        -> schema validation        (ours, always, regardless of vendor features)
 *        -> semantic validation      (intent in taxonomy, citation containment, re-check validity)
 *        -> policy/authority gate    (produces the capability token, or denies)
 *        -> staleness guard          (re-read state; supersede if the world moved)
 *        -> atomic commit            (decision + outbound + watermark + events, together)
 *
 * Every early exit is a recorded state with a reason. "The AI did nothing" is never silent.
 */

export interface RunModeratorResult {
  readonly runId: ModeratorRunId;
  readonly state: ModeratorRun['state'];
  readonly skipReason: SkipReason | null;
  readonly finalAction: ActionType | null;
  readonly outboundActionId: OutboundActionId | null;
  readonly policyOutcome: PolicyOutcome | null;
}

export interface RunModeratorConfig {
  /** Phase 0 never contacts a provider; outbound actions are recorded as SIMULATED. */
  readonly simulateOutbound: boolean;
  /** Shadow mode: run and record suggestions while a human owns the conversation. Default off. */
  readonly shadowModeEnabled: boolean;
  /** Bound on moderator retries. Set explicitly so exhaustion behaviour is never accidental. */
  readonly maxAttempts: number;
}

export const DEFAULT_RUN_CONFIG: RunModeratorConfig = {
  simulateOutbound: true,
  shadowModeEnabled: false,
  maxAttempts: 5,
};

export interface RunModeratorDeps {
  readonly accounts: AccountRepository;
  /**
   * Read for one reason only: to discover whether the conversation's connection is receive-only.
   *
   * The moderator does not route, does not resolve identities and never contacts a provider. It
   * asks the connection a single yes/no question, and a `null` answer counts as yes (objective 8).
   */
  readonly connections: ChannelConnectionRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly runs: ModeratorRunRepository;
  readonly outbound: OutboundActionRepository;
  readonly handoffs: HandoffRepository;
  readonly packs: AccountPackRepository;
  readonly knowledgeGate: KnowledgeGate;
  readonly knowledgeGaps: KnowledgeGapRepository;
  readonly provider: LlmProvider;
  readonly models: ModelResolver;
  readonly queue: JobQueue;
  readonly outbox: EventOutbox;
  readonly audit: AuditLog;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly config?: RunModeratorConfig;
}

export interface RunModeratorService {
  run(
    conversationId: ConversationId,
    scope: AccountScope,
    signal?: AbortSignal,
  ): Promise<RunModeratorResult>;
}

export function createRunModeratorService(deps: RunModeratorDeps): RunModeratorService {
  const config = deps.config ?? DEFAULT_RUN_CONFIG;

  return {
    async run(conversationId, scope, signal) {
      const conversation = await deps.conversations.findById(scope, conversationId);
      if (!conversation) {
        throw new TerminalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', {
          conversationId,
        });
      }

      const account = await deps.accounts.findById(scope.accountId);
      if (!account) {
        throw new TerminalError('ACCOUNT_NOT_FOUND', 'Account does not exist', {
          accountId: scope.accountId,
        });
      }

      const traceId = deps.ids.next<TraceId>(ID_PREFIX.trace);
      const logger = deps.logger.child({
        account_id: scope.accountId,
        conversation_id: conversationId,
        trace_id: traceId,
      });

      const pack = await deps.packs.findActive(scope);

      // --- deterministic admission checks ------------------------------------------------------
      const skip = admissionSkipReason(conversation, account.status, pack !== null, config);
      if (skip) {
        const run = newRun(deps, scope, conversation, pack?.id ?? null, traceId);
        const skipped = transitionRun(transitionRun(run, 'RUNNING'), 'SKIPPED', {
          skipReason: skip,
          finishedAt: deps.clock.now(),
        });
        await deps.runs.save(scope, skipped);
        await deps.audit.append(scope, {
          action: 'moderator.run_skipped',
          subjectType: 'conversation',
          subjectId: conversationId,
          actorKind: 'SYSTEM',
          actorUserId: null,
          detail: { reason: skip },
          occurredAt: deps.clock.now(),
        });
        logger.info('moderator run skipped', { reason: skip });
        return {
          runId: skipped.id,
          state: 'SKIPPED',
          skipReason: skip,
          finalAction: null,
          outboundActionId: null,
          policyOutcome: null,
        };
      }

      // Admission passed, so a pack exists.
      const activePack = pack!;
      const taxonomy = resolveIntentTaxonomy(activePack);
      const escalation = resolveEscalationPolicy(activePack);
      const matrix = resolveAuthorityMatrix(activePack);
      const voice = resolveBrandVoice(activePack);

      let run = newRun(deps, scope, conversation, activePack.id, traceId);
      run = transitionRun(run, 'RUNNING');
      await deps.runs.save(scope, run);

      const transcript = await deps.messages.listByConversation(scope, conversationId);
      const locale = conversation.locale ?? account.defaultLocale;

      // --- knowledge retrieval (before the model, always) --------------------------------------
      const candidates = await deps.knowledgeGate.retrieve(
        scope,
        {
          locale,
          intentCodes: [...taxonomy.codes],
          tags: deriveRetrievalTags(transcript.map((m) => m.text ?? '')),
        },
        deps.clock.now(),
      );

      // --- model call ---------------------------------------------------------------------------
      const binding = deps.models.resolve('REASON');
      const request = buildModeratorRequest({
        brandTone: voice.tone,
        mustNotSay: voice.mustNotSay,
        taxonomy,
        surface: conversation.surface,
        locale,
        knowledge: candidates.entries,
        transcript,
        allowedActions: allowedActionNames(matrix, conversation.surface),
        maxOutputTokens: binding.maxOutputTokens,
        temperature: binding.temperature,
      });

      const startedAt = deps.clock.nowMs();
      const structured = await completeStructured(
        { provider: deps.provider },
        moderatorDecisionSchema,
        request,
        {
          role: 'REASON',
          timeoutMs: binding.timeoutMs,
          traceId,
          ...(signal ? { signal } : {}),
        },
      );
      const proposal = structured.value;

      run = {
        ...run,
        rawResponse: structured.response.text,
        llm: {
          provider: deps.provider.id,
          model: structured.response.model,
          role: 'REASON',
          tokensIn: structured.response.tokensIn,
          tokensOut: structured.response.tokensOut,
          latencyMs: deps.clock.nowMs() - startedAt,
          costEstimate: null,
          attempts: structured.attempts,
        },
      };

      // --- semantic validation and policy -------------------------------------------------------
      const evaluated = await evaluateProposal({
        deps,
        scope,
        conversation,
        account: { canAct: canActAutonomously(account) },
        proposal,
        candidates,
        taxonomy,
        escalation,
        matrix,
        runId: run.id,
        traceId,
        packVersionId: activePack.id,
        inputWatermark: run.inputWatermark,
      });

      // --- staleness guard ----------------------------------------------------------------------
      // Re-read *now*, after the slow part. If a human took over or a new message arrived while
      // the model was thinking, this decision is about a conversation that no longer exists in
      // that form, and delivering it would mean talking over a human (I4, F-13).
      const fresh = await deps.conversations.findById(scope, conversationId);
      if (!fresh) {
        throw new TerminalError('CONVERSATION_DISAPPEARED', 'Conversation vanished mid-run', {
          conversationId,
        });
      }
      const guard = checkStalenessGuard(run, {
        ownershipVersion: fresh.ownershipVersion,
        lastInboundSeq: fresh.lastInboundSeq,
      });

      if (!guard.ok) {
        const superseded = transitionRun(run, 'SUPERSEDED', { finishedAt: deps.clock.now() });
        await deps.runs.save(scope, superseded);
        await deps.audit.append(scope, {
          action: 'moderator.run_superseded',
          subjectType: 'moderator_run',
          subjectId: run.id,
          actorKind: 'SYSTEM',
          actorUserId: null,
          detail: { reason: guard.reason },
          occurredAt: deps.clock.now(),
        });
        // No outbound, and the watermark does not move — so the messages this run considered are
        // still pending for whoever handles the conversation next.
        if (guard.reason === 'NEW_INPUT_ARRIVED' && mayActAutonomously(fresh)) {
          const routing = resolveRoutingPolicy(activePack);
          await deps.queue.enqueueCoalesced(
            {
              accountId: scope.accountId,
              type: 'moderator.run',
              partitionKey: scopedPartitionKey(scope, 'conv', conversationId),
              dedupeKey: `moderator.run:${conversationId}`,
              payload: { conversationId },
              runAt: deps.clock.now(),
              maxAttempts: config.maxAttempts,
              traceId,
            },
            { debounceMs: routing.debounceMs, maxDelayMs: routing.maxDelayMs },
          );
        }
        logger.info('moderator run superseded', { reason: guard.reason });
        return {
          runId: run.id,
          state: 'SUPERSEDED',
          skipReason: null,
          finalAction: null,
          outboundActionId: null,
          policyOutcome: null,
        };
      }

      // --- atomic commit -------------------------------------------------------------------------
      const supersede = async (reason: string): Promise<RunModeratorResult> => {
        const superseded = transitionRun(run, 'SUPERSEDED', { finishedAt: deps.clock.now() });
        await deps.runs.save(scope, superseded);
        await deps.audit.append(scope, {
          action: 'moderator.run_superseded',
          subjectType: 'moderator_run',
          subjectId: run.id,
          actorKind: 'SYSTEM',
          actorUserId: null,
          detail: { reason },
          occurredAt: deps.clock.now(),
        });
        logger.info('moderator run superseded', { reason });
        return {
          runId: run.id,
          state: 'SUPERSEDED' as const,
          skipReason: null,
          finalAction: null,
          outboundActionId: null,
          policyOutcome: null,
        };
      };

      try {
        return await deps.transactions.run(async () => {
          let outboundActionId: OutboundActionId | null = null;
          let awaitingReview = false;

          if (evaluated.authorization) {
            // Two independent brakes, and either one alone is sufficient.
            //
            // `config.simulateOutbound` is process-wide: it says this deployment sends nothing.
            // Receive-only is per connection: it says *this client's* transport is attached for
            // observation. A real Meta connection can therefore be shadowed on a process that is
            // otherwise armed, one tenant at a time (objective 8) — and a connection that has
            // gone missing since the conversation was created simulates too, because "I could
            // not find the connection" is not a licence to send.
            const connection = await deps.connections.findById(scope, fresh.channelConnectionId);
            const simulate =
              config.simulateOutbound || connection === null || isReceiveOnly(connection);
            if (simulate && !config.simulateOutbound) {
              logger.info('outbound simulated by receive-only connection', {
                channel_connection_id: fresh.channelConnectionId,
              });
            }
            const action = createOutboundAction(evaluated.authorization, {
              id: deps.ids.next<OutboundActionId>(ID_PREFIX.outboundAction),
              accountId: scope.accountId,
              conversationId,
              moderatorRunId: run.id,
              ordinal: 0,
              payload: evaluated.payload,
              createdAt: deps.clock.now(),
              simulate,
            });
            await deps.outbound.save(scope, action);
            outboundActionId = action.id;
            awaitingReview = action.deliveryMode === 'SUGGESTED';
          }

          let committed = fresh;

          if (evaluated.finalAction === 'REQUEST_HUMAN_HANDOFF') {
            const handoff = createHandoff(
              deps,
              scope,
              fresh,
              run.id,
              evaluated.handoffReason,
              escalation.handoffSlaMs,
            );
            await deps.handoffs.save(scope, handoff);
            const transitioned = transitionOwnership(committed, {
              to: 'PENDING_HUMAN',
              actorKind: 'POLICY',
              reason: evaluated.handoffReason,
              moderatorRunId: run.id,
              at: deps.clock.now(),
            });
            committed = transitioned.conversation;
            await deps.conversations.appendOwnershipTransition(scope, transitioned.record);
            await publish(deps, scope, {
              type: 'sales.handoff_requested',
              subject: { type: 'conversation', id: conversationId },
              traceId,
              data: {
                conversation_id: conversationId,
                handoff_id: handoff.id,
                // The handoff row already truncates the reason; reuse it so the event contract
                // (reason_code, max 64 chars) cannot be violated by a long policy explanation.
                reason_code: handoff.reasonCode,
                urgency: 'NORMAL',
              },
            });
          }

          // The watermark advances only here, inside the same transaction that records the outcome.
          // Moving it anywhere else is how a customer message gets silently skipped (I4).
          //
          // Compare-and-swap, not a blind write. The staleness guard above read the conversation
          // before this transaction opened; a human takeover landing in that window would otherwise
          // be overwritten by this stale snapshot, and the AI would have talked over them after all
          // (F-13). A lost CAS aborts the transaction, so the outbound action, the handoff and the
          // watermark all roll back together.
          const applied = await deps.conversations.saveIfUnchanged(
            scope,
            {
              ...committed,
              lastProcessedInboundSeq: run.inputWatermark,
              // A suggested draft has reached nobody. Marking the conversation AWAITING_CUSTOMER
              // would tell an operator the ball is in the customer's court when it is in fact
              // sitting in the review queue — the exact misreading this account is being onboarded
              // to fix. It stays AWAITING_MODERATOR until a person acts.
              engagement:
                outboundActionId !== null && !awaitingReview
                  ? 'AWAITING_CUSTOMER'
                  : committed.engagement,
            },
            // `committed` carries a bumped version when this run raised its own handoff; the row on
            // disk still holds the version the guard observed.
            fresh.ownershipVersion,
          );
          if (!applied) {
            throw new ConcurrencyConflictError('conversation', fresh.ownershipVersion);
          }

          const completed = transitionRun(run, 'COMPLETED', {
            decision: {
              proposal,
              policyOutcome: evaluated.policyOutcome,
              policyReason: evaluated.policyReason,
              finalAction: evaluated.finalAction,
              knowledgeRefsUsed: evaluated.knowledgeRefsUsed,
            },
            finishedAt: deps.clock.now(),
          });
          await deps.runs.save(scope, completed);

          await publish(deps, scope, {
            type: 'intent.detected',
            subject: { type: 'conversation', id: conversationId },
            traceId,
            data: {
              conversation_id: conversationId,
              moderator_run_id: run.id,
              intent_code: proposal.intent.code,
              confidence: proposal.intent.confidence,
            },
          });

          for (const event of evaluated.extraEvents) {
            await publish(deps, scope, { ...event, traceId });
          }

          if (evaluated.policyOutcome === 'DENIED' || evaluated.policyOutcome === 'DOWNGRADED') {
            await deps.audit.append(scope, {
              action: 'moderator.action_denied',
              subjectType: 'moderator_run',
              subjectId: run.id,
              actorKind: 'POLICY',
              actorUserId: null,
              detail: {
                proposed: proposal.proposed_action,
                final: evaluated.finalAction,
                reason: evaluated.policyReason,
              },
              occurredAt: deps.clock.now(),
            });
          }

          logger.info('moderator run completed', {
            intent: proposal.intent.code,
            proposed: proposal.proposed_action,
            final: evaluated.finalAction,
            outcome: evaluated.policyOutcome,
          });

          return {
            runId: run.id,
            state: 'COMPLETED' as const,
            skipReason: null,
            finalAction: evaluated.finalAction,
            outboundActionId,
            policyOutcome: evaluated.policyOutcome,
          };
        });
      } catch (error) {
        // The whole transaction rolled back, so there is no outbound action, no handoff and no
        // advanced watermark to undo. Record why, and leave the messages pending for the human who
        // now owns the conversation.
        if (error instanceof ConcurrencyConflictError) {
          return await supersede('OWNERSHIP_CHANGED_DURING_COMMIT');
        }
        throw error;
      }
    },
  };
}

// --- admission ----------------------------------------------------------------------------------

function admissionSkipReason(
  conversation: Conversation,
  accountStatus: string,
  hasPack: boolean,
  config: RunModeratorConfig,
): SkipReason | null {
  if (accountStatus === 'SUSPENDED' || accountStatus === 'ARCHIVED') return 'ACCOUNT_SUSPENDED';
  if (conversation.lifecycle === 'CLOSED') return 'CONVERSATION_CLOSED';
  // First of the two independent ownership checks required by I5. The second is in the gate.
  if (!mayActAutonomously(conversation) && !config.shadowModeEnabled) return 'NOT_AI_OWNED';
  if (!hasPack) return 'NO_ACTIVE_PACK';
  if (!hasUnprocessedInbound(conversation)) return 'NO_UNPROCESSED_INPUT';
  return null;
}

function newRun(
  deps: RunModeratorDeps,
  scope: AccountScope,
  conversation: Conversation,
  packVersionId: ModeratorRun['packVersionId'] | null,
  traceId: TraceId,
): ModeratorRun {
  return {
    id: deps.ids.next<ModeratorRunId>(ID_PREFIX.moderatorRun),
    accountId: scope.accountId,
    conversationId: conversation.id,
    state: 'PENDING',
    trigger: 'INBOUND_MESSAGE',
    inputWatermark: conversation.lastInboundSeq,
    observedOwnershipVersion: conversation.ownershipVersion,
    packVersionId: packVersionId ?? ('apv_none' as ModeratorRun['packVersionId']),
    promptTemplateVersion: MODERATOR_PROMPT_VERSION,
    decision: null,
    llm: null,
    rawResponse: null,
    skipReason: null,
    error: null,
    jobId: null,
    traceId,
    startedAt: deps.clock.now(),
    finishedAt: null,
  };
}

// --- proposal evaluation ---------------------------------------------------------------------

interface EvaluatedProposal {
  readonly finalAction: ActionType;
  readonly policyOutcome: PolicyOutcome;
  readonly policyReason: string;
  readonly authorization: AuthorizedAction | null;
  readonly payload: OutboundActionPayload;
  readonly knowledgeRefsUsed: readonly string[];
  readonly handoffReason: string;
  readonly extraEvents: readonly ExtraEvent[];
}

interface ExtraEvent {
  readonly type: 'faq.unanswered';
  readonly subject: { readonly type: string; readonly id: string };
  readonly data: Readonly<Record<string, string>>;
}

async function evaluateProposal(input: {
  deps: RunModeratorDeps;
  scope: AccountScope;
  conversation: Conversation;
  account: { canAct: boolean };
  proposal: ModeratorDecisionProposal;
  candidates: KnowledgeCandidateSet;
  taxonomy: ReturnType<typeof resolveIntentTaxonomy>;
  escalation: ReturnType<typeof resolveEscalationPolicy>;
  matrix: ReturnType<typeof resolveAuthorityMatrix>;
  runId: ModeratorRunId;
  traceId: TraceId;
  /** Snapshotted onto a suggested draft so a reviewer sees the configuration that produced it. */
  packVersionId: string;
  inputWatermark: number;
}): Promise<EvaluatedProposal> {
  const { deps, scope, conversation, proposal, candidates, taxonomy, escalation, matrix } = input;
  const now = deps.clock.now();
  const extraEvents: ExtraEvent[] = [];

  let intended: ActionType = proposal.proposed_action;
  let reason = 'model proposal accepted for evaluation';

  // An intent outside the supplied taxonomy is a hallucination, not a new category.
  if (taxonomy.codes.size > 0 && !taxonomy.codes.has(proposal.intent.code)) {
    intended = 'REQUEST_HUMAN_HANDOFF';
    reason = `intent '${proposal.intent.code}' is not in the account taxonomy`;
  }

  if (proposal.needs_human) {
    intended = 'REQUEST_HUMAN_HANDOFF';
    reason = proposal.handoff_reason ?? 'model requested a human';
  }

  // Citation containment plus a re-check of commercial validity (a price can expire mid-run).
  const verification = deps.knowledgeGate.verifyCitations(candidates, proposal.knowledge_refs, now);

  // "Insufficient knowledge" is decided here, in code, from the candidate set and the citations —
  // never by asking the model how confident it feels.
  const needsKnowledge = taxonomy.requiresKnowledge.has(proposal.intent.code);
  const knowledgeMissing =
    needsKnowledge && (candidates.entries.length === 0 || proposal.knowledge_refs.length === 0);

  if (knowledgeMissing || (proposal.knowledge_refs.length > 0 && !verification.verified)) {
    const gapId = deps.ids.next(ID_PREFIX.knowledgeGap);
    await deps.knowledgeGaps.record(scope, {
      accountId: scope.accountId,
      conversationId: conversation.id,
      moderatorRunId: input.runId,
      questionShape: normaliseQuestionShape(proposal.intent.code, proposal.entities),
      intentCode: proposal.intent.code,
      locale: proposal.detected_locale ?? 'unknown',
      observedAt: now,
    });
    extraEvents.push({
      type: 'faq.unanswered',
      subject: { type: 'conversation', id: conversation.id },
      data: {
        conversation_id: conversation.id,
        knowledge_gap_id: gapId,
        question_shape: normaliseQuestionShape(proposal.intent.code, proposal.entities),
        intent_code: proposal.intent.code,
        locale: proposal.detected_locale ?? 'unknown',
      },
    });
    intended = escalation.insufficientKnowledgeAction;
    reason = knowledgeMissing
      ? 'no approved knowledge available for a knowledge-requiring intent'
      : verification.reason;
  }

  const downgraded = intended !== proposal.proposed_action;
  const payload = buildPayload(intended, proposal, reason);
  const hasReplyText = (candidate: OutboundActionPayload): boolean =>
    typeof candidate.text === 'string' && candidate.text.length > 0;

  const gateFor = (
    action: ActionType,
    mode: ActionGateInput['requestedDeliveryMode'],
    candidate: OutboundActionPayload,
    verified: boolean,
    citations: number,
  ) =>
    gateAction({
      conversationId: conversation.id,
      surface: conversation.surface,
      ownership: conversation.ownership,
      lifecycle: conversation.lifecycle,
      ownershipVersion: conversation.ownershipVersion,
      accountCanActAutonomously: input.account.canAct,
      action,
      requestedDeliveryMode: mode,
      matrix,
      knowledgeVerified: verified,
      citationCount: citations,
      hasReplyText: hasReplyText(candidate),
      now,
    });

  const gate = gateFor(
    intended,
    'AUTONOMOUS',
    payload,
    verification.verified,
    proposal.knowledge_refs.length,
  );

  if (gate.outcome === 'ALLOWED') {
    return {
      finalAction: intended,
      policyOutcome: downgraded ? 'DOWNGRADED' : 'ALLOWED',
      policyReason: downgraded ? reason : gate.reason,
      authorization: gate.authorization,
      payload,
      knowledgeRefsUsed: verification.usedIds,
      handoffReason: reason,
      extraEvents,
    };
  }

  // The account's matrix says a person must approve this action. That is emphatically *not* the
  // same as "discard it" — which is what this branch used to do, dropping the drafted reply on
  // the floor and handing the reviewer a bare handoff reason. Ask again for the weaker thing:
  // permission to *suggest*.
  //
  // Everything that made the autonomous request unsafe still applies, because `gateAction`
  // re-runs every check. A suggestion with no citation is still refused. What changes is only
  // that a matrix effect of REQUIRE_APPROVAL now resolves to a suppressed draft with the text
  // attached, waiting for the named human it was always meant for.
  if (gate.outcome === 'REQUIRES_APPROVAL') {
    const suggest = gateFor(
      intended,
      'SUGGESTED',
      payload,
      verification.verified,
      proposal.knowledge_refs.length,
    );
    if (suggest.outcome === 'ALLOWED') {
      return {
        finalAction: intended,
        policyOutcome: 'REQUIRES_APPROVAL',
        policyReason: gate.reason,
        authorization: suggest.authorization,
        payload: {
          ...payload,
          review: {
            intentCode: proposal.intent.code,
            intentConfidence: proposal.intent.confidence,
            overallConfidence: proposal.confidence,
            risk: ACTION_RISK[intended],
            proposedAction: proposal.proposed_action,
            policyReason: gate.reason,
            knowledgeRefs: verification.usedIds,
            packVersionId: input.packVersionId,
            promptVersion: MODERATOR_PROMPT_VERSION,
            inputWatermark: input.inputWatermark,
            moderatorRunId: input.runId,
          },
        },
        knowledgeRefsUsed: verification.usedIds,
        handoffReason: reason,
        extraEvents,
      };
    }
    // A suggestion was refused too — the grounding rules, not the matrix. Fall through.
  }

  // A denial must never mean "do nothing and say nothing" while a customer waits. Fall back to
  // asking a human, and gate *that* too — the fallback is not privileged.
  const fallback = fallbackActionFor(intended);
  const fallbackPayload = buildPayload(fallback, proposal, gate.reason);
  const fallbackGate = gateFor(fallback, 'AUTONOMOUS', fallbackPayload, true, 0);

  return {
    finalAction: fallbackGate.outcome === 'ALLOWED' ? fallback : 'NO_ACTION',
    policyOutcome: gate.outcome === 'REQUIRES_APPROVAL' ? 'REQUIRES_APPROVAL' : 'DENIED',
    policyReason: gate.reason,
    authorization: fallbackGate.outcome === 'ALLOWED' ? fallbackGate.authorization : null,
    payload: fallbackPayload,
    knowledgeRefsUsed: [],
    handoffReason: gate.reason,
    extraEvents,
  };
}

function buildPayload(
  action: ActionType,
  proposal: ModeratorDecisionProposal,
  reason: string,
): OutboundActionPayload {
  switch (action) {
    case 'ANSWER_FROM_KNOWLEDGE':
    case 'PUBLIC_REPLY':
    case 'ASK_CLARIFICATION':
    case 'MOVE_TO_DIRECT_MESSAGE':
      return { ...(proposal.reply_text !== undefined ? { text: proposal.reply_text } : {}) };
    case 'ADD_TAG':
      return { tags: proposal.tags ?? [] };
    case 'CAPTURE_FIELD':
      return {
        capturedFields: Object.fromEntries(
          (proposal.capture_fields ?? []).map((f) => [f.field, f.value]),
        ),
      };
    case 'REQUEST_HUMAN_HANDOFF':
      return { handoffReason: proposal.handoff_reason ?? reason };
    case 'CREATE_LEAD_CANDIDATE':
      return {
        capturedFields: Object.fromEntries(
          (proposal.capture_fields ?? []).map((f) => [f.field, f.value]),
        ),
      };
    case 'NO_ACTION':
    case 'HIDE_COMMENT':
    case 'DELETE_COMMENT':
    case 'BLOCK_USER':
      return {};
  }
}

function createHandoff(
  deps: RunModeratorDeps,
  scope: AccountScope,
  conversation: Conversation,
  runId: ModeratorRunId,
  reason: string,
  slaMs: number,
): Handoff {
  const now = deps.clock.now();
  return {
    id: deps.ids.next<HandoffId>(ID_PREFIX.handoff),
    accountId: scope.accountId,
    conversationId: conversation.id,
    kind: 'HUMAN_AGENT',
    state: 'REQUESTED',
    reasonCode: reason.slice(0, 64),
    urgency: 'NORMAL',
    targetQueue: null,
    assignedUserId: null,
    contextSummary: { surface: conversation.surface, reason },
    triggeringRunId: runId,
    requestedAt: now,
    assignedAt: null,
    acceptedAt: null,
    completedAt: null,
    slaDueAt: new Date(now.getTime() + slaMs),
  };
}

async function publish(
  deps: RunModeratorDeps,
  scope: AccountScope,
  event: {
    type: Parameters<typeof assertPublishable>[0]['type'];
    subject: { type: string; id: string };
    traceId: TraceId;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const envelope = {
    eventId: deps.ids.next<DomainEventId>(ID_PREFIX.domainEvent),
    type: event.type,
    version: 1,
    occurredAt: deps.clock.now(),
    accountId: scope.accountId,
    subject: event.subject,
    traceId: event.traceId,
    data: event.data as Parameters<typeof assertPublishable>[0]['data'],
  };
  assertPublishable(envelope);
  await deps.outbox.append(scope, envelope);
}

/** Only actions the account's matrix permits are offered to the model at all. */
function allowedActionNames(
  matrix: ReturnType<typeof resolveAuthorityMatrix>,
  surface: Conversation['surface'],
): string[] {
  return ACTION_TYPES.filter((action) => {
    const rule =
      matrix.rules.find((r) => r.action === action && r.surface === surface) ??
      matrix.rules.find((r) => r.action === action && r.surface === '*');
    return rule?.effect === 'ALLOW';
  });
}

/**
 * Reduces a question to a minimised shape for the knowledge-gap backlog.
 *
 * Deliberately derived from the intent and entity *keys*, never the customer's sentence — the gap
 * record and the `faq.unanswered` event both leave the moderation boundary (ADR-009).
 */
function normaliseQuestionShape(
  intentCode: string,
  entities: Readonly<Record<string, string>> | undefined,
): string {
  const keys = Object.keys(entities ?? {}).sort();
  return keys.length > 0 ? `${intentCode}(${keys.join(',')})` : intentCode;
}

/**
 * Deterministic retrieval keys from message text (ADR-010, open decision D1).
 *
 * Normalised word stems above a length threshold. Crude, and deliberately so: an unevaluated
 * clever retriever that silently returns the wrong entry is worse than a simple one whose misses
 * are visible as knowledge gaps.
 *
 * Normalisation is not a refinement of that crudeness, it is what makes it work at all. Arabic
 * tokenises correctly on codepoints, so this looked fine before — while `الكرسي` failed to match
 * a `كرسي` tag and the miss surfaced as a handoff rather than as a bug. Both sides of the
 * comparison now go through the same function (`platform/text/normalize-arabic.ts`): entry tags
 * at import, customer text here.
 */
function deriveRetrievalTags(texts: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const text of texts) {
    for (const token of tokenize(text)) tags.add(token);
  }
  return [...tags].slice(0, 50);
}
