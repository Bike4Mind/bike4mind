/* Auto-derived from the tree via scoped `Resource.*` access analysis.
   Regenerate after product-code extraction - some entries are transient (see TRANSIENT tags). */
import type { Manifest } from './index';

export const DEFAULT_MANIFEST = {
  // --- secret ---
  // Integration secrets are optional: unset disables that integration. Only the
  // core boot secrets (JWT/session/encryption/Mongo) are hard-required.
  ANTHROPIC_API_KEY: { kind: 'secret', optional: true },
  B4M_ANALYTICS_ENABLED: { kind: 'secret', optional: true },
  B4M_PROD_API_KEY: { kind: 'secret', optional: true },
  // Shared-secret bearer for the frontend -> ChatCompletion /process dispatch. Required:
  // chat dispatch fails closed (401) without it. Distinct from SECRET_ENCRYPTION_KEY.
  CHAT_COMPLETION_INTERNAL_SECRET: { kind: 'secret' },
  E2E_CLEANUP_SECRET: { kind: 'secret', optional: true },
  EMERGENCY_LOGIN_ENABLED: { kind: 'secret', optional: true },
  GEMINI_API_KEY: { kind: 'secret', optional: true },
  GITHUB_CLIENT_ID: { kind: 'secret', optional: true },
  GITHUB_CLIENT_SECRET: { kind: 'secret', optional: true },
  GITHUB_ZAP_REF: { kind: 'secret', optional: true },
  GOOGLE_CLIENT_ID: { kind: 'secret', optional: true },
  GOOGLE_CLIENT_SECRET: { kind: 'secret', optional: true },
  JWT_SECRET: { kind: 'secret' },
  MAIL_FROM: { kind: 'secret', optional: true },
  MAIL_HOST: { kind: 'secret', optional: true },
  MAIL_PASSWORD: { kind: 'secret', optional: true },
  MAIL_PORT: { kind: 'secret', optional: true },
  MAIL_USERNAME: { kind: 'secret', optional: true },
  MONGODB_URI: { kind: 'secret' },
  OAUTH_RSA_PRIVATE_KEY: { kind: 'secret', optional: true },
  OKTA_AUDIENCE: { kind: 'secret', optional: true },
  OKTA_CLIENT_ID: { kind: 'secret', optional: true },
  OKTA_CLIENT_SECRET: { kind: 'secret', optional: true },
  OKTA_USE_ORG_AUTH_SERVER: { kind: 'secret', optional: true },
  OPENAI_API_KEY: { kind: 'secret', optional: true },
  OVERWATCH_INGEST_ENABLED: { kind: 'secret', optional: true }, // transient: removed after product extraction
  OVERWATCH_INGEST_KEY: { kind: 'secret', optional: true }, // transient: removed after product extraction
  OVERWATCH_INGEST_URL: { kind: 'secret', optional: true }, // transient: removed after product extraction
  OVERWATCH_PSEUDONYM_SALT: { kind: 'secret', optional: true }, // transient: removed after product extraction
  OPTIHASHI_API_TOKEN: { kind: 'secret', optional: true },
  OPTIHASHI_API_URL: { kind: 'secret', optional: true },
  OPTIHASHI_WEBHOOK_SECRET: { kind: 'secret', optional: true },
  OPTIHASHI_WEBHOOK_SECRET_PREVIOUS: { kind: 'secret', optional: true },
  RATE_LIMIT_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECOPS_ATTACK_SIMULATION_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECOPS_CODE_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECOPS_PACKAGES_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECOPS_PROWLER_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECOPS_PROWLER_WORKFLOW_TOKEN: { kind: 'secret', optional: true },
  SECOPS_SECRETS_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECOPS_ZAP_DISPATCH_TOKEN: { kind: 'secret', optional: true },
  SECOPS_ZAP_INGEST_TOKEN: { kind: 'secret', optional: true },
  SECRET_ENCRYPTION_KEY: { kind: 'secret' },
  SECRET_ENCRYPTION_KEY_PREVIOUS: { kind: 'secret', optional: true },
  SESSION_SECRET: { kind: 'secret' },
  SLACK_ERROR_REPORTING_WEBHOOK_URL: { kind: 'secret', optional: true },
  SLACK_WEBHOOK_URL: { kind: 'secret', optional: true },
  STRIPE_PUBLISHABLE_KEY: { kind: 'secret', optional: true },
  STRIPE_SECRET_KEY: { kind: 'secret', optional: true },
  STRIPE_WEBHOOK_SECRET: { kind: 'secret', optional: true },
  SUPPORT_EMAIL: { kind: 'secret', optional: true },
  WHATS_NEW_DISTRIBUTION_URL: { kind: 'secret', optional: true },
  XAI_API_KEY: { kind: 'secret', optional: true },
  // --- bucket ---
  appFilesBucket: { kind: 'bucket' },
  emailIngestionBucket: { kind: 'bucket' },
  fabFileBucket: { kind: 'bucket' },
  generatedImagesBucket: { kind: 'bucket' },
  historyImportBucket: { kind: 'bucket' },
  publishedArtifactsBucket: { kind: 'bucket' },
  slackExportBucket: { kind: 'bucket' },
  // --- queue ---
  agentContinuationQueue: { kind: 'queue' },
  agentProactiveMessageQueue: { kind: 'queue' },
  deepAgentWakeQueue: { kind: 'queue' },
  emailAnalysisQueue: { kind: 'queue', optional: true },
  emailBatchQueue: { kind: 'queue' },
  emailIngestionQueue: { kind: 'queue' },
  emailJobQueue: { kind: 'queue' },
  fabFileChunkQueue: { kind: 'queue' },
  fabFileVectorizeQueue: { kind: 'queue' },
  liveOpsTriageQueue: { kind: 'queue' },
  notebookCurationQueue: { kind: 'queue', optional: true },
  researchEngineQueue: { kind: 'queue' },
  sreAnalysisQueue: { kind: 'queue' },
  sreFixQueue: { kind: 'queue' },
  // --- function ---
  AgentExecutor: { kind: 'function' },
  AppEventBus: { kind: 'function' },
  HistoryUploadCompleteFunction: { kind: 'function' },
  ImageProcessor: { kind: 'function' },
  NotebookImportCompleteFunction: { kind: 'function' },
  SlackEventBus: { kind: 'function' },
  mcpHandler: { kind: 'function', optional: true },
  // --- service ---
  // Always-on chatCompletion HTTP service the frontend dispatches quests to
  // (`${CHAT_COMPLETION}/process`). Required: chat is broken without it.
  ChatCompletion: { kind: 'service' },
  // --- websocket ---
  websocket: { kind: 'websocket' },
  // --- record ---
  lambdaFunctionNames: { kind: 'record', optional: true },
} as const satisfies Manifest;
