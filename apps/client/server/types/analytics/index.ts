import {
  AiEvents,
  AiEventPayload,
  ApiKeyEventPayload,
  ApiKeyEvents,
  AppFileEventPayload,
  AppFileEvents,
  AuthEventPayload,
  AuthEvents,
  CurationEventPayload,
  CurationEvents,
  LLMEventPayload,
  LLMEvents,
  ElabsEventPayload,
  ElabsEvents,
  FeedbackEventPayload,
  FeedbackEvents,
  FileEventPayload,
  FileEvents,
  InboxEventPayload,
  InboxEvents,
  InviteEventPayload,
  InviteEvents,
  MiscEventPayload,
  MiscEvents,
  ModalEventPayload,
  ModalEvents,
  RegInviteEventPayload,
  RegInviteEvents,
  SessionEventPayload,
  SessionEvents,
  UiNavigationEventPayload,
  UiNavigationEvents,
  ProjectEvents,
  ProjectEventPayloads,
  ProfileEvents,
  ProfileEventPayload,
  FriendshipEvents,
  FriendshipEventPayload,
  OrganizationEvents,
  OrganizationEventPayload,
  UserApiKeyEvents,
  UserApiKeyEventPayload,
  SlackEvents,
  SlackEventPayload,
  HelpEvents,
  HelpEventPayload,
  MarketingReportEvents,
  MarketingReportEventPayload,
  BriefcaseEvents,
  BriefcaseEventPayload,
} from '@bike4mind/common';
import { AdminConfigAuditEvents, AdminOrgAuditEvents, EmailAuditEvents } from '@server/utils/auditLogEvents';

export const ANALYTICS_EVENTS = {
  ...BriefcaseEvents,
  ...MarketingReportEvents,
  ...AuthEvents,
  ...SessionEvents,
  ...ApiKeyEvents,
  ...UserApiKeyEvents,
  ...UiNavigationEvents,
  ...AppFileEvents,
  ...CurationEvents,
  ...LLMEvents,
  ...RegInviteEvents,
  ...MiscEvents,
  ...ModalEvents,
  ...FileEvents,
  ...ElabsEvents,
  ...FeedbackEvents,
  ...InboxEvents,
  ...AiEvents,
  ...InviteEvents,
  ...ProjectEvents,
  ...ProfileEvents,
  ...FriendshipEvents,
  ...OrganizationEvents,
  ...SlackEvents,
  ...HelpEvents,
  // Audit-log event families (registered so logAuditEvent -> logEvent does
  // not throw "Invalid counter event" inside withTransaction handlers).
  ...EmailAuditEvents,
  ...AdminConfigAuditEvents,
  ...AdminOrgAuditEvents,
};

export type AnalyticsEvents = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

export type AnalyticsEventPayloads =
  | AuthEventPayload
  | SessionEventPayload
  | ApiKeyEventPayload
  | UserApiKeyEventPayload
  | UiNavigationEventPayload
  | AppFileEventPayload
  | CurationEventPayload
  | LLMEventPayload
  | RegInviteEventPayload
  | MiscEventPayload
  | ModalEventPayload
  | FileEventPayload
  | ElabsEventPayload
  | FeedbackEventPayload
  | InboxEventPayload
  | AiEventPayload
  | InviteEventPayload
  | ProjectEventPayloads
  | ProfileEventPayload
  | FriendshipEventPayload
  | OrganizationEventPayload
  | SlackEventPayload
  | HelpEventPayload
  | MarketingReportEventPayload
  | BriefcaseEventPayload;
