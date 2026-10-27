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

export const OTHER_CATEGORY = 'Other';

/**
 * Dashboard category for each analytics event enum. A new event enum in
 * b4m-core/common/src/schemas/analytics/events must be added here, or its events
 * are reported as Other (categorizeEvent.test.ts guards the existing ones).
 */
export const EVENT_ENUM_CATEGORIES: ReadonlyArray<readonly [Record<string, string>, string]> = [
  [AiEvents, 'AI'],
  [ApiKeyEvents, 'API Keys'],
  [AppFileEvents, 'File'],
  [AuthEvents, 'Auth'],
  [BriefcaseEvents, 'Briefcase'],
  [CreditPurchaseEvents, 'Credits'],
  [CurationEvents, 'Curation'],
  [ElabsEvents, 'Voice'],
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

const CATEGORY_BY_EVENT_NAME: ReadonlyMap<string, string> = new Map(
  EVENT_ENUM_CATEGORIES.flatMap(([events, category]) =>
    Object.values(events).map(eventName => [eventName, category] as const)
  )
);

export function categorizeEvent(eventName: string): string {
  return CATEGORY_BY_EVENT_NAME.get(eventName) ?? OTHER_CATEGORY;
}
