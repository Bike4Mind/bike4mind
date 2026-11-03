import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import { registerToolbelts, type AgentExtensionContribution } from '@bike4mind/agents';
import { Logger } from '@bike4mind/observability';
import { premiumAgentExtensions } from '@bike4mind/server-utils/premium-generated/premiumAgentExtensions.generated';

// Imported for its side effect by every module that builds a wake act executor, so a contributed
// role resolves to its toolbelt however the wake is entered.
export function registerContributedToolbelts(
  contributions: readonly AgentExtensionContribution[],
  logger: Pick<Logger, 'warn'>
): void {
  const { taken, invalid } = registerToolbelts(contributions.flatMap(c => c?.toolbelts ?? []));
  if (taken.length > 0) {
    logger.warn('Dropped contributed toolbelts whose role is already taken', { roles: taken });
  }
  if (invalid > 0) {
    logger.warn('Dropped malformed contributed toolbelts', { count: invalid });
  }
}

registerContributedToolbelts(premiumAgentExtensions, new Logger({ metadata: { handler: 'deepAgentToolbelts' } }));
