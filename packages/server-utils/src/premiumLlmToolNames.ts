import './lib/settings/registerContributedSettings';
import { premiumLlmTools } from './premium-generated/premiumLlmTools.generated';

/** Names of the generated tool map; static per build, so computed once. */
export const premiumLlmToolNames: ReadonlySet<string> = Object.freeze(new Set(Object.keys(premiumLlmTools)));
