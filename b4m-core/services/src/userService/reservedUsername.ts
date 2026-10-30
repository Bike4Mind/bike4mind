import {
  IAdminSettingsRepository,
  isReservedUsername,
  isSyntheticIdentity,
  parseSyntheticDomainList,
  RESERVED_USERNAME_MESSAGE,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

/**
 * Reject a username an ordinary user may not hold: one carrying the test-persona prefix
 * (isReservedUsername). The only self-service allowance is a proven email on a configured synthetic
 * test domain (`syntheticUserEmailDomains`), i.e. an account analytics already sets aside, so the
 * name hides nothing. Pass `provenEmail` only when the caller has verified the address (OTC code,
 * emailVerified). A settings read failure denies. Admin and test-only paths do not call this; they
 * opt in to reserved names explicitly (see createUser's `allowReservedUsername`).
 */
export async function assertUsernameNotReserved(
  username: string,
  provenEmail: string | null | undefined,
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'> | undefined
): Promise<void> {
  if (!isReservedUsername(username)) return;
  if (provenEmail && adminSettings) {
    let domains: string[] = [];
    try {
      domains = parseSyntheticDomainList(
        (await adminSettings.findBySettingName('syntheticUserEmailDomains'))?.settingValue
      );
    } catch {
      // Fall through to the rejection: a reserved name needs a positive answer.
    }
    if (isSyntheticIdentity({ email: provenEmail }, domains)) return;
  }
  throw new BadRequestError(RESERVED_USERNAME_MESSAGE);
}
