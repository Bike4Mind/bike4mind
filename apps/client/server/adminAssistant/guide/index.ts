import { AI_AND_CONTENT_GUIDE } from './entries/aiAndContent';
import { OPERATIONS_GUIDE } from './entries/operations';
import { TRUST_AND_SAFETY_GUIDE } from './entries/trustAndSafety';
import { USERS_AND_BILLING_GUIDE } from './entries/usersAndBilling';
import type { AdminGuideEntry } from './types';

export type { AdminGuideEntry } from './types';
export { searchAdminGuide } from './search';

/** Every admin feature the assistant can explain. Adding an admin tab? Add its entry (guide.test.ts checks). */
export const ADMIN_GUIDE: readonly AdminGuideEntry[] = [
  ...TRUST_AND_SAFETY_GUIDE,
  ...USERS_AND_BILLING_GUIDE,
  ...AI_AND_CONTENT_GUIDE,
  ...OPERATIONS_GUIDE,
];
