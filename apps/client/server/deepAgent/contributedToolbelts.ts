import { registerToolbelts, type AgentExtensionContribution } from '@bike4mind/agents';
import { Logger } from '@bike4mind/observability';
import { premiumAgentExtensions } from '@server/premium-generated/premiumAgentExtensions.generated';

// Imported for its side effect by every module that builds a wake act executor, so a contributed
// role resolves to its toolbelt however the wake is entered.
export function registerContributedToolbelts(
  contributions: readonly AgentExtensionContribution[],
  logger: Pick<Logger, 'warn'>
): void {
  const dropped = registerToolbelts(contributions.flatMap(c => c.toolbelts ?? []));
  if (dropped.length > 0) {
    logger.warn('Dropped contributed toolbelts whose role is already taken', { roles: dropped });
  }
}

registerContributedToolbelts(premiumAgentExtensions, new Logger({ metadata: { handler: 'deepAgentToolbelts' } }));
