import { ADMIN_FEEDBACK_TAB_SLUG } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';

/**
 * URL slug -> AdminTab, for the console's `?tab=` deep-link param.
 *
 * Only tabs something actually links to need an entry. `AdminTab`'s values are positional, so
 * they must never reach a URL: a link built today would retarget the first time the enum is
 * reordered, and these links live in Slack messages and emails. The slugs themselves are declared
 * in common/utils/deepLinks alongside the builders that emit them.
 *
 * A Map, not an object literal: the key comes straight from the query string, and an object
 * lookup would resolve `?tab=toString` to an inherited Object.prototype member instead of
 * undefined - which then passes the caller's `!== undefined` guard.
 */
const SLUG_TO_ADMIN_TAB: ReadonlyMap<string, AdminTab> = new Map([[ADMIN_FEEDBACK_TAB_SLUG, AdminTab.Feedback]]);

/** Resolves a `?tab=` slug, or undefined when it is absent or not a linkable tab. */
export function adminTabFromSlug(slug: string | undefined): AdminTab | undefined {
  if (!slug) return undefined;
  return SLUG_TO_ADMIN_TAB.get(slug);
}
