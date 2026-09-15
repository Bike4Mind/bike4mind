/**
 * Read-only workflow-view commands: /decisions, /blockers, /review-gates.
 *
 * The `print*` helpers are exported because the `/workflow <sub>` command in
 * index.tsx renders the same views for its subcommands - keeping one source of
 * truth here avoids the format logic drifting between the two entry points.
 */
import {
  formatDecisionsOutput,
  formatBlockersOutput,
  formatReviewGatesOutput,
  type DecisionStore,
  type BlockerStore,
  type ReviewGateStore,
} from '../../tools';
import type { CommandHandler } from '../types';

export function printDecisions(store: DecisionStore): void {
  console.log('\n📋 Decision Log\n');
  console.log(formatDecisionsOutput(store.decisions));
  console.log('');
}

export function printBlockers(store: BlockerStore): void {
  console.log('\n🚧 Blockers\n');
  console.log(formatBlockersOutput(store.blockers));
  console.log('');
}

export function printReviewGates(store: ReviewGateStore): void {
  console.log('\n🛑 Review Gates\n');
  console.log(formatReviewGatesOutput(store.reviewGates));
  console.log('');
}

export const workflowViewCommands: CommandHandler[] = [
  { name: 'decisions', run: (_args, ctx) => printDecisions(ctx.decisionStore) },
  { name: 'blockers', run: (_args, ctx) => printBlockers(ctx.blockerStore) },
  { name: 'review-gates', run: (_args, ctx) => printReviewGates(ctx.reviewGateStore) },
];
