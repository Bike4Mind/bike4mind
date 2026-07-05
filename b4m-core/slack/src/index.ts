/**
 * @bike4mind/slack
 *
 * Slack integration package for Bike4Mind.
 *
 * This package provides the core Slack integration logic including:
 * - SlackClient (Slack Web API wrapper)
 * - Event handling and routing
 * - Command processing
 * - OAuth installation flow
 * - Workspace and user linking
 * - GitHub/Jira/Confluence resource integrations
 * - Thread intelligence and message enrichment
 * - App Home and modal builders
 *
 * Must call configureSlackPackage() before use to inject server
 * and database dependencies.
 */

// ─── DI Layer ────────────────────────────────────────────────────────────────
export { configureSlackPackage, getSlackDeps, getSlackDb, isSlackPackageConfigured } from './di';

export type {
  ISlackServerDependencies,
  ISlackDatabaseDependencies,
  IJwtStateStore,
  JwtStateStoreOptions,
  BaseStatePayload,
  VerifyResult,
  ISessionManager,
  GetOrCreateSessionParams,
  GetOrCreateSessionResult,
  IAuthAbility,
  IIntegrationCircuitBreaker,
  ICloudwatch,
  IChatCompletionDefaults,
  ILLMEvent,
  IEventBus,
  IMcpEnv,
  EnvVariable,
  IMcpHandler,
  McpHandlerPayload,
  IAnalyticsManager,
  IStorage,
  IGithubRepoHelper,
  ISstResources,
} from './di';

// ─── Core Classes ────────────────────────────────────────────────────────────
export { SlackClient } from './SlackClient';
export type { SlackMessage } from './SlackClient';
export { SlackEvent } from './SlackEvent';
export type { SlackEventData } from './SlackEvent';
export { SlackMessageEnricher } from './SlackMessageEnricher';
export { CommandHandler } from './CommandHandler';

// ─── Agent Parser ────────────────────────────────────────────────────────────
export { AGENT_REGISTRY, buildSystemPrompt, parseImageModelOverride } from './agent-parser';
export type { BuildSystemPromptOptions } from './agent-parser';

// ─── Tools ───────────────────────────────────────────────────────────────────
export { generateHelpMessage } from './tools/slackbotHelp';
export { listCuratedFiles, getCuratedFiles } from './tools/listCuratedFiles';
export type { ListCuratedFilesParams, ListCuratedFilesResult } from './tools/listCuratedFiles';
export { shareCuratedFile } from './tools/shareCuratedFile';
export type { ShareCuratedFileParams, ShareCuratedFileResult } from './tools/shareCuratedFile';
export { notebookNew } from './tools/notebookNew';
export type { NotebookNewParams, NotebookNewResult } from './tools/notebookNew';
export { notebookStatus } from './tools/notebookStatus';
export type { NotebookStatusParams, NotebookStatusResult } from './tools/notebookStatus';

export { slackToolDefinitions } from './tools/toolDefinitions';
export { createPendingActionToolDefs } from './tools/pendingActionTools';
export type { PendingActionDeps, PendingActionResult } from './tools/pendingActionTools';

// ─── Custom Agent Adapter ────────────────────────────────────────────────────
export { customAgentToPersona } from './custom-agent-adapter';

// ─── Installer / OAuth ───────────────────────────────────────────────────────
export { createInstallProvider, getDefaultInstallUrlOptions, getInstallUrlOptionsForWorkspace } from './installer';
export type { InstallationMetadata } from './installer';

// ─── Org Slack Helpers ───────────────────────────────────────────────────────
export {
  getSystemSlackAppCredentials,
  generateOrgSlackConnectStateToken,
  verifyOrgSlackConnectStateToken,
  buildOrgSlackOAuthUrl,
} from './org-slack-helpers';

// ─── User Link Helpers ───────────────────────────────────────────────────────
export {
  generateUserLinkStateToken,
  verifyUserLinkStateToken,
  getOAuthWorkspaceWithCredentials,
  buildUserLinkRedirectUri,
  buildSlackOAuthUrl,
} from './user-link-helpers';

// ─── Markdown Processing ─────────────────────────────────────────────────────
export { processMarkdownForSlack } from './utils/slackMarkdown';
export type { SlackFormattedResult } from './utils/slackMarkdown';

// ─── Confirmation ────────────────────────────────────────────────────────────
export { buildAttachmentDownloadButtons, buildConfirmationButtons, formatPreviewFromParams } from './confirmation';
export { buildImageModelPicker, getImageModelDisplayName, IMAGE_GEN_MODEL_ACTION_ID } from './confirmation';
export type {
  AttachmentDownloadInfo,
  SlackBlockKitButton,
  SlackBlockKitActions,
  SlackBlockKitDivider,
  SlackBlockKitSection,
  SlackBlockKitContext,
  SlackBlockKitElement,
} from './confirmation';
export { TOKEN_EXPIRATION_MS } from './confirmation-token';

// ─── Image Generation ────────────────────────────────────────────────────────
export { triggerImageGeneration } from './imageGeneration';
export type { TriggerImageGenerationParams } from './imageGeneration';

// ─── Constants ───────────────────────────────────────────────────────────────
export { SYSTEM_MODEL_DEFAULTS } from './constants/system-model-defaults';
export { buildSlackModelOptionsFromDashboard } from './constants/slack-model-options';
export { getImageConfigForModel } from './constants/slack-image-defaults';
export { TARGET_SYSTEM_AGENT_MAP } from './constants/routing';

// ─── Handlers ────────────────────────────────────────────────────────────────
export { handleChannelCommand } from './handlers/channel-manager';
export {
  handleGlobalShortcut,
  handleCreateNotebookSubmission,
  handleQuickAskSubmission,
  SHORTCUT_CALLBACK_IDS,
} from './handlers/globalShortcutHandlers';
export type {
  GlobalShortcutPayload,
  ViewSubmissionPayload as ShortcutViewSubmissionPayload,
  ViewSubmissionResponse as ShortcutViewSubmissionResponse,
} from './handlers/globalShortcutHandlers';
export {
  handleOrgDefaultsEdit,
  handleOrgModelDefaultsSubmission,
  handleChannelConfigAdd,
  handleChannelConfigEdit,
  handleChannelConfigRemove,
  handleChannelModelConfigSubmission,
  refreshAppHomeForAdmin,
} from './handlers/modelConfigHandlers';
export type {
  ViewSubmissionPayload,
  ViewSubmissionResponse,
  ViewSubmissionPayload as ModelConfigViewSubmissionPayload,
  ViewSubmissionResponse as ModelConfigViewSubmissionResponse,
} from './handlers/modelConfigHandlers';
export {
  updateUserSlackSettings,
  determineThreadStrategy,
  getOrCreateNotebookForSlackUser,
} from './handlers/notebook-manager';
export {
  formatAgentResponse,
  sendMessageToNotebookAndGetResponse,
  splitLongText,
  splitTextIntoBlocks,
} from './handlers/notebook-messaging';
export { handleSearchCommand } from './handlers/search-handler';
export {
  mapSlackUserIdToGithubUsername,
  mapSlackUserIdsToGithubUsernames,
  extractSlackUserIdsFromText,
  containsSelfAssignmentPattern,
  buildMappingContext,
  isPlainTextAssignee,
  looksLikeGithubUsername,
  findUsersByDisplayName,
  buildAssigneeClarificationMessage,
} from './handlers/slack-github-mapper';
export type { SlackGitHubMapping } from './handlers/slack-github-mapper';
export { findUserBySlackId, handleUnlinkedUser, createMockUser } from './handlers/user-lookup';
export { WorkflowStepHandler, WORKFLOW_STEP_CALLBACKS } from './handlers/WorkflowStepHandler';
export type { FunctionExecutedEvent } from './handlers/WorkflowStepHandler';

// ─── Modals ──────────────────────────────────────────────────────────────────
export {
  buildChannelModelConfigModal,
  parseChannelModelConfigSubmission,
  CHANNEL_MODEL_CONFIG_CALLBACK_ID,
} from './modals/ChannelModelConfigModal';
export type { ChannelModelConfigModalParams, ChannelModelConfigSubmission } from './modals/ChannelModelConfigModal';
export {
  buildOrgModelDefaultsModal,
  parseOrgModelDefaultsSubmission,
  ORG_MODEL_DEFAULTS_CALLBACK_ID,
} from './modals/OrgModelDefaultsModal';
export type { OrgModelDefaultsModalParams, OrgModelDefaultsSubmission } from './modals/OrgModelDefaultsModal';
export {
  buildScheduleMessageModal,
  parseScheduleMessageSubmission,
  SCHEDULE_MESSAGE_CALLBACK_ID,
} from './modals/ScheduleMessageModal';
export type { ScheduleMessageModalParams, ScheduleMessageSubmission } from './modals/ScheduleMessageModal';

// ─── Resources ───────────────────────────────────────────────────────────────
export { BaseResource } from './resources/BaseResource';
export { ConfluenceResource } from './resources/ConfluenceResource';
export { GitHubResource } from './resources/GitHubResource';
export { InternalResource } from './resources/InternalResource';
export { JiraResource } from './resources/JiraResource';

// ─── Services ────────────────────────────────────────────────────────────────
export { AppHomeDataService } from './services/AppHomeDataService';
export type { AppHomeNotebook } from './services/AppHomeDataService';
export { SlackAuditLogger, getClientIp } from './services/SlackAuditLogger';

// ─── Thread Intelligence ─────────────────────────────────────────────────────
export {
  analyzeThread,
  summarizeThread,
  extractTopics,
  detectDecisions,
  extractActionItems,
  extractAttachments,
  analyzeSentiment,
  analyzeParticipants,
  formatThreadIntelligence,
  calculateTimeSpan,
} from './thread-intelligence';
export type {
  ThreadIntelligence,
  ThreadSummary,
  Decision,
  ActionItem,
  Participant,
  Attachment,
  SlackMessage as ThreadSlackMessage,
} from './thread-intelligence';

// ─── Views ───────────────────────────────────────────────────────────────────
export { AppHomeBuilder, buildErrorHomeView } from './views/AppHomeBuilder';
export type { ChannelConfigSummary, AppHomeUserContext } from './views/AppHomeBuilder';

// ─── Utils ───────────────────────────────────────────────────────────────────
export { createLoadingBar } from './utils/loadingBar';
export { parseReminderExpression } from './utils/reminder-parser';
export type { ParsedReminder } from './utils/reminder-parser';
export {
  parseTimeExpression,
  validateScheduledTime,
  parseAndValidateTime,
  formatDateTime,
  nowInSeconds,
} from './utils/time-parser';
export type { ParsedTime, TimeValidationResult } from './utils/time-parser';

// ─── Validators ──────────────────────────────────────────────────────────────

// ─── Workflow Errors ─────────────────────────────────────────────────────────
export {
  WorkflowError,
  WorkflowErrorCategory,
  DEFAULT_RETRY_OPTIONS,
  withRetry,
  categorizeError,
} from './workflowErrors';
export type { WorkflowErrorOptions, RetryOptions } from './workflowErrors';

// ─── Manifest ────────────────────────────────────────────────────────────────
export { generateFullManifest, getControlledScopes, getControlledManifestFields } from './manifestTemplate';
export type { ControlledManifestFields, FullManifest } from './manifestTemplate';
export { compareManifests, mergeManifest, extractBaseUrl } from './manifestComparator';

// ─── GitHub ──────────────────────────────────────────────────────────────────
export { GitHubSlackNotifier } from './github/GitHubSlackNotifier';
export type { NotifyResult, GitHubNotificationEventType } from './github/GitHubSlackNotifier';
export {
  buildCIFailedBlocks,
  buildCIPassedBlocks,
  buildPushBlocks,
  buildPROpenedBlocks,
  buildPRMergedBlocks,
  buildPRApprovedBlocks,
  buildPRChangesRequestedBlocks,
  buildReviewRequestedBlocks,
  buildPRReviewCommentBlocks,
  buildMentionBlocks,
  buildIssueOpenedBlocks,
  buildIssueClosedBlocks,
  buildIssueAssignedBlocks,
} from './github/blockTemplates';

// ─── Commands ────────────────────────────────────────────────────────────────
export { handleRemindCommand } from './commands/reminderCommands';
export { handleB4mCommand } from './commands/scheduleCommands';

// ─── Slack Export Errors ─────────────────────────────────────────────────────
export {
  SLACK_USER_VALIDATION_ERRORS,
  isSlackUserValidationError,
  isSlackUserValidationErrorCode,
  isSlackUserValidationErrorByMessage,
  SLACK_USER_ERROR_MESSAGE_PATTERNS,
} from './slack-export-errors';
export type { SlackUserValidationError, SlackErrorType, SlackErrorMetadata } from './slack-export-errors';
