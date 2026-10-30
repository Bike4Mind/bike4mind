import {
  AiEvents,
  ApiKeyEvents,
  AppFileEvents,
  AuthEvents,
  BriefcaseEvents,
  CreditPurchaseEvents,
  CurationEvents,
  ElabsEvents,
  FeedbackEvents,
  FileEvents,
  FirstRunEvents,
  FriendshipEvents,
  HelpEvents,
  InboxEvents,
  IntegrationsEvents,
  InviteEvents,
  LLMEvents,
  MarketingReportEvents,
  MiscEvents,
  ModalEvents,
  OrganizationEvents,
  ProfileEvents,
  ProjectEvents,
  RegInviteEvents,
  SessionEvents,
  SlackEvents,
  UiNavigationEvents,
  UserApiKeyEvents,
} from '@bike4mind/common';
import {
  AdminConfigAuditEvents,
  AdminOrgAuditEvents,
  DataLakeAuditEvents,
  EmailAuditEvents,
} from '@bike4mind/server-utils/utils/auditLogEvents';

export const OTHER_CATEGORY = 'Other';

/**
 * Dashboard category for each enum spread into ANALYTICS_EVENTS
 * (packages/server-utils/src/types/analytics/index.ts). A new enum there must be added here, or its
 * events are reported as Other (categorizeEvent.test.ts fails until it is).
 */
export const EVENT_ENUM_CATEGORIES: ReadonlyArray<readonly [Record<string, string>, string]> = [
  [AdminConfigAuditEvents, 'Audit'],
  [AdminOrgAuditEvents, 'Audit'],
  [AiEvents, 'AI'],
  [ApiKeyEvents, 'API Keys'],
  [AppFileEvents, 'File'],
  [AuthEvents, 'Auth'],
  [BriefcaseEvents, 'Briefcase'],
  [CreditPurchaseEvents, 'Credits'],
  [CurationEvents, 'Curation'],
  [DataLakeAuditEvents, 'Audit'],
  [ElabsEvents, 'Voice'],
  [EmailAuditEvents, 'Audit'],
  [FeedbackEvents, 'Feedback'],
  [FileEvents, 'File'],
  [FirstRunEvents, 'Onboarding'],
  [FriendshipEvents, 'Social'],
  [HelpEvents, 'Help'],
  [InboxEvents, 'Inbox'],
  [IntegrationsEvents, 'Integrations'],
  [InviteEvents, 'Invite'],
  [LLMEvents, 'LLM'],
  [MarketingReportEvents, 'Marketing'],
  [MiscEvents, 'Misc'],
  [ModalEvents, 'Modal'],
  [OrganizationEvents, 'Organization'],
  [ProfileEvents, 'Profile'],
  [ProjectEvents, 'Project'],
  [RegInviteEvents, 'Invite'],
  [SessionEvents, 'Session'],
  [SlackEvents, 'Slack'],
  [UiNavigationEvents, 'Navigation'],
  [UserApiKeyEvents, 'API Keys'],
];

// Feeds the admin Event Category filter, so it offers exactly the categories categorizeEvent returns.
export const EVENT_CATEGORIES: readonly string[] = [
  ...[...new Set(EVENT_ENUM_CATEGORIES.map(([, category]) => category))].sort(),
  OTHER_CATEGORY,
];

const CATEGORY_BY_EVENT_NAME: ReadonlyMap<string, string> = new Map(
  EVENT_ENUM_CATEGORIES.flatMap(([events, category]) =>
    Object.values(events).map(eventName => [eventName, category] as const)
  )
);

export function categorizeEvent(eventName: string): string {
  return CATEGORY_BY_EVENT_NAME.get(eventName) ?? OTHER_CATEGORY;
}
