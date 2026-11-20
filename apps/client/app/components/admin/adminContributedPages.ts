import { Puzzle } from 'lucide-react';
import { isFullAdmin } from '@bike4mind/common';
import type { PremiumRouteDescriptor } from '../../premiumContract';
import { contributedPageTestId } from './adminExtPath';
import type { SidebarPageLink, SidebarSection } from './adminSidebarConfig';

/** What the admin shell needs of a contributed page: the descriptor's path and its sidebar entry. */
export type ContributedAdminPage = Pick<PremiumRouteDescriptor, 'path'> & {
  adminPage: NonNullable<PremiumRouteDescriptor['adminPage']>;
};

/**
 * Contributed pages are open to full admins only: they are not in DELEGATED_ADMIN_TAB_PERMISSIONS,
 * so there is no permission a delegate could hold that opens one.
 */
export const canOpenContributedAdminPage = (user: Parameters<typeof isFullAdmin>[0]): boolean => isFullAdmin(user);

/**
 * `sections` with each contributed page added after the items of the section it names, in the order
 * given. Returns `sections` itself when there is nothing to add, so the sidebar is unchanged.
 */
export const withContributedPages = (
  sections: SidebarSection[],
  pages: readonly ContributedAdminPage[]
): SidebarSection[] => {
  if (pages.length === 0) return sections;
  const linksBySection = new Map<string, SidebarPageLink[]>();
  for (const { path, adminPage } of pages) {
    const link: SidebarPageLink = {
      Icon: adminPage.Icon ?? Puzzle,
      label: adminPage.label,
      path,
      testid: adminPage.testId ?? contributedPageTestId(path),
    };
    linksBySection.set(adminPage.section, [...(linksBySection.get(adminPage.section) ?? []), link]);
  }
  return sections.map(section => {
    const links = linksBySection.get(section.key);
    return links ? { ...section, pages: [...(section.pages ?? []), ...links] } : section;
  });
};
