import {
  hasAdminPermission,
  isFullAdmin,
  meetsAdminPermissionRequirement,
  MODERATION_PAGE_READ,
  SETTINGS_PAGE_READ,
  CREDITS_PAGE_READ,
  type AdminPermissionRequirement,
} from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';

type AdminIdentity = Parameters<typeof hasAdminPermission>[0];

/**
 * The tabs a delegated admin (`adminPermissions` without `isAdmin`) may open, and the permission
 * each one needs. Fail closed: list a tab only once every request it makes accepts that
 * permission server-side. An unlisted tab stays full-admin only, so a delegate never lands on a
 * pane its own requests answer with 403. A list admits any one of its permissions: a write
 * permission's own pages list it beside `support:read`, matching their routes' GET requirement.
 */
export const DELEGATED_ADMIN_TAB_PERMISSIONS: Readonly<Partial<Record<AdminTab, AdminPermissionRequirement>>> = {
  // The modal endpoints' CASL rules grant read and write on settings:manage. What's new shares
  // them but stays out: its highlights panel and LiveOps lookup are full-admin only.
  [AdminTab.Modals]: 'settings:manage',
  [AdminTab.AiOperations]: 'settings:manage',

  // Read-only for support:read. Their write controls name the permission they need
  // (AdminPermissionAction), or are already decided per row by the server (Approvals, Audit log).
  [AdminTab.RetrievalRate]: 'support:read',
  [AdminTab.WebhookAuditLogs]: 'support:read',
  [AdminTab.HelpAnalytics]: 'support:read',
  [AdminTab.ApiKeyScopePreflight]: 'support:read',
  [AdminTab.IntegrationDemand]: 'support:read',
  [AdminTab.AuditLog]: 'support:read',
  [AdminTab.Approvals]: 'support:read',
  [AdminTab.StripeDisputes]: 'support:read',
  [AdminTab.ShadowDetections]: 'support:read',

  // View-only for support:read; replay actions gate on settings:manage inside the tab.
  [AdminTab.DlqReplay]: 'support:read',

  // Pages whose writes need settings:manage; their GET routes declare the same SETTINGS_PAGE_READ.
  [AdminTab.ToolDefinitions]: SETTINGS_PAGE_READ,
  [AdminTab.ManageGears]: SETTINGS_PAGE_READ,
  [AdminTab.AgentExecutions]: SETTINGS_PAGE_READ,

  // Subscriptions: writes need credits:adjust and its GET routes declare the same CREDITS_PAGE_READ.
  [AdminTab.Subscriptions]: CREDITS_PAGE_READ,
  // Its list, release and revoke routes all declare credits:adjust.
  [AdminTab.HeldSignupGrants]: 'credits:adjust',
  // Pages whose writes need users:moderate; their GET routes declare the same MODERATION_PAGE_READ.
  [AdminTab.EmailVerification]: MODERATION_PAGE_READ,
  [AdminTab.SignupDomainHolds]: MODERATION_PAGE_READ,
  [AdminTab.SignupRiskReview]: MODERATION_PAGE_READ,
  [AdminTab.RateLimits]: MODERATION_PAGE_READ,
  [AdminTab.PublishedPages]: MODERATION_PAGE_READ,
};

export function canOpenAdminTab(user: AdminIdentity, tab: AdminTab): boolean {
  if (isFullAdmin(user)) return true;
  const requirement = DELEGATED_ADMIN_TAB_PERMISSIONS[tab];
  return requirement !== undefined && meetsAdminPermissionRequirement(user, requirement);
}

/**
 * Whether the admin console has anything to show this user. A delegate whose permissions open no
 * tab is turned away rather than shown an empty console.
 */
export function canEnterAdminConsole(user: AdminIdentity): boolean {
  if (isFullAdmin(user)) return true;
  return Object.values(DELEGATED_ADMIN_TAB_PERMISSIONS).some(
    requirement => requirement !== undefined && meetsAdminPermissionRequirement(user, requirement)
  );
}
