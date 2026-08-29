import { scopeForAccount } from '../../core/account/index.ts';
import { TerminalError } from '../../platform/errors.ts';
import { asId } from '../../platform/ids.ts';
import type { OutboundActionId, UserId } from '../../platform/ids.ts';
import type { ReviewDecision } from '../../moderation/domain/review.ts';
import { emit, fail, openCliContext, parseArgs } from './context.ts';

/**
 * `review` — the human review queue for suggested replies (ADR-011).
 *
 * A CLI rather than a web UI, on purpose. A UI implies a workflow, and the workflow for this
 * account is one person working a short queue during business hours; the interesting question in
 * Phase 02C is whether the drafts are any good, not what the buttons look like. Everything below
 * is a thin shell over `moderation/application/review.ts`, so the eventual UI calls the same
 * service and cannot acquire a capability this command does not have.
 *
 * **Approving does not send.** `approve` and `edit` move the draft to `APPROVED_FOR_MANUAL_SEND`
 * and print the text. A person copies it into Meta Inbox and sends it themselves. There is no
 * dispatcher in this system to hand it to — `outbound.dispatch` is absent from the worker's
 * handler map and an architecture test keeps it absent.
 *
 * Usage
 *   node src/runtime/cli/review.ts list     --account acc_... [--limit 20]
 *   node src/runtime/cli/review.ts show     --account acc_... --action oba_...
 *   node src/runtime/cli/review.ts approve  --account acc_... --action oba_... --reviewer usr_...
 *   node src/runtime/cli/review.ts edit     --account acc_... --action oba_... --reviewer usr_... --text "..."
 *   node src/runtime/cli/review.ts reject   --account acc_... --action oba_... --reviewer usr_... --reason "..."
 *   node src/runtime/cli/review.ts escalate --account acc_... --action oba_... --reviewer usr_... --reason "..."
 */

const USAGE = `usage:
  review list     --account <id> [--limit <n>]
  review show     --account <id> --action <id>
  review approve  --account <id> --action <id> --reviewer <user id>
  review edit     --account <id> --action <id> --reviewer <user id> --text <replacement>
  review reject   --account <id> --action <id> --reviewer <user id> --reason <why>
  review escalate --account <id> --action <id> --reviewer <user id> --reason <why>`;

const DECISIONS: Readonly<Record<string, ReviewDecision>> = {
  approve: 'APPROVED',
  edit: 'EDITED',
  reject: 'REJECTED',
  escalate: 'ESCALATED',
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const decision = DECISIONS[command];
  if (command !== 'list' && command !== 'show' && !decision) {
    throw new TerminalError('ARGS_INVALID', `unknown command '${command}'\n${USAGE}`);
  }
  const accountId = args['account'];
  if (!accountId) throw new TerminalError('ARGS_INVALID', `--account is required\n${USAGE}`);

  const ctx = openCliContext();
  try {
    const account = await ctx.container.accounts.findById(asId(accountId));
    if (!account) throw new TerminalError('ACCOUNT_NOT_FOUND', 'no such account', { accountId });
    const scope = scopeForAccount(account);
    const review = ctx.container.review;

    if (command === 'list') {
      const limit = args['limit'] ? Number.parseInt(args['limit'], 10) : 20;
      const items = await review.list(scope, limit);
      const now = ctx.container.clock.now().getTime();
      emit({
        ok: true,
        pending: items.length,
        items: items.map((item) => ({
          action: item.action.id,
          conversation: item.conversation.id,
          surface: item.conversation.surface,
          actionType: item.action.actionType,
          intent: item.action.payload.review?.intentCode ?? null,
          risk: item.action.payload.review?.risk ?? null,
          confidence: item.action.payload.review?.overallConfidence ?? null,
          citations: item.action.payload.review?.knowledgeRefs.length ?? 0,
          // The number the audit's worst finding was about: a price question that sat five days.
          waitingHours: Math.round(((now - item.pendingSince.getTime()) / 3_600_000) * 10) / 10,
          preview: preview(item.action.payload.text),
        })),
      });
      return;
    }

    const actionId = args['action'];
    if (!actionId) throw new TerminalError('ARGS_INVALID', `--action is required\n${USAGE}`);

    if (command === 'show') {
      const detail = await review.show(scope, asId<OutboundActionId>(actionId));
      emit({
        ok: true,
        action: {
          id: detail.action.id,
          type: detail.action.actionType,
          deliveryMode: detail.action.deliveryMode,
          state: detail.action.state,
          draft: detail.action.payload.text ?? null,
        },
        context: detail.action.payload.review ?? null,
        conversation: {
          id: detail.conversation.id,
          surface: detail.conversation.surface,
          ownership: detail.conversation.ownership,
          locale: detail.conversation.locale,
        },
        transcript: detail.transcript.map((message) => ({
          seq: message.seq,
          direction: message.direction,
          author: message.authorKind,
          text: message.text,
        })),
        citedKnowledge: detail.citedKnowledge.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          body: entry.body,
          price: entry.price,
          validUntil: entry.validUntil?.toISOString() ?? null,
        })),
        // Loud, because approving a draft whose evidence has since expired would put a stale
        // claim in front of a customer under a human's signature.
        unresolvedCitations: detail.unresolvedCitations,
        // Non-null only once someone has accepted the draft; it is the text they are to send.
        finalText: detail.finalText,
        run: detail.run
          ? {
              id: detail.run.id,
              promptVersion: detail.run.promptTemplateVersion,
              llm: detail.run.llm,
            }
          : null,
        history: detail.history,
      });
      return;
    }

    const reviewer = args['reviewer'];
    if (!reviewer) throw new TerminalError('ARGS_INVALID', `--reviewer is required\n${USAGE}`);
    if (command === 'edit' && !args['text']) {
      throw new TerminalError('ARGS_INVALID', '--text is required for edit');
    }
    if ((command === 'reject' || command === 'escalate') && !args['reason']) {
      throw new TerminalError('ARGS_INVALID', `--reason is required for ${command}`);
    }

    const result = await review.decide(scope, {
      actionId: asId<OutboundActionId>(actionId),
      decision: decision!,
      reviewerUserId: asId<UserId>(reviewer),
      ...(args['reason'] ? { reason: args['reason'] } : {}),
      ...(args['text'] ? { editedText: args['text'] } : {}),
    });

    emit({
      ok: true,
      decision: result.review.decision,
      reviewId: result.review.id,
      action: result.action.id,
      state: result.action.state,
      handoffId: result.handoffId,
      originalDraft: result.review.originalText,
      textForManualSend: result.textForManualSend,
      // Stated on every accepted decision, because the one thing an operator must not assume is
      // that pressing approve did the sending for them.
      nextStep:
        result.textForManualSend === null
          ? 'No reply will be sent. The conversation is recorded as handled by a person.'
          : 'NOT SENT. Copy the text above into Meta Inbox and send it yourself — this system has no send capability.',
    });
  } finally {
    await ctx.close();
  }
}

function preview(text: string | undefined): string | null {
  if (!text) return null;
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
}

await main().catch(fail);
