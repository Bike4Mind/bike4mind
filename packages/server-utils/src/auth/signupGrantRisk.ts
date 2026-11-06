import { canonicalizeEmail, emailDomainCandidates, type INetworkMeta, type IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository, disposableDomainRepository, User } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { createSignupRiskCollector } from './signupNetworkSignals';

/** Only persisted account facts and trusted server observations may enter a grant decision. */
export function createSignupGrantRiskCollector(network?: INetworkMeta) {
  const collectNetwork = createSignupRiskCollector(network);
  return async (user: IUserDocument): Promise<userService.SignupRiskSignals> => {
    const signals = { ...(await collectNetwork(user)), challengeVerified: user.signupMeta?.challengeVerified ?? null };
    const email = user.email;
    const canonical = email ? canonicalizeEmail(email) : null;
    if (!email || !canonical) return signals;

    const collision = await User.exists({ freeCreditClaimEmail: canonical, _id: { $ne: user.id } }).maxTimeMS(2000);
    const blockedDomain = await userService.isAdminBlockedEmailDomain(email, {
      adminSettings: adminSettingsRepository,
    });
    const sources = await disposableDomainRepository.disposableSources(emailDomainCandidates(email));
    return {
      ...signals,
      canonicalEmailCollision: collision !== null,
      blockedDomain,
      disposableDomain: userService.isDisposableEmail(email) || sources.length > 0,
    };
  };
}
