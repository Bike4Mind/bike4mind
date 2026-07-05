export const SECRET_ROTATION_CONFIG: {
  [key: string]: {
    description: string;
    rotationIntervalDays: number;
    isAutomatic: boolean;
    rotationProcess: string;
  };
} = {
  // ── Authentication ─────────────────────────────────────────────────────────
  MONGODB_URI: {
    description: 'Database Credentials',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Update in MongoDB Atlas UI and update SST Secret',
  },
  JWT_SECRET: {
    description: 'Authentication Secrets',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Generate new random string (min 32 chars) and update SST Secret',
  },
  SESSION_SECRET: {
    description: 'Authentication Secrets',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Generate new random string and update SST Secret',
  },

  // ── Encryption & PKI ───────────────────────────────────────────────────────
  SECRET_ENCRYPTION_KEY: {
    description: 'AES-256-GCM key used to encrypt secrets stored in the database',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess:
      'Generate new key: openssl rand -hex 32. Copy current value to SECRET_ENCRYPTION_KEY_PREVIOUS, then set the new value via sst secret set. Existing encrypted values are re-encrypted on next read.',
  },
  OAUTH_RSA_PRIVATE_KEY: {
    description: 'RSA private key for signing OIDC ID tokens (RS256)',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess:
      'Generate new key: openssl genrsa 2048 | base64 | tr -d "\\n". Update via sst secret set. Existing sessions signed with the old key will require re-login.',
  },

  // ── OAuth Integrations ─────────────────────────────────────────────────────
  GOOGLE_CLIENT_SECRET: {
    description: 'OAuth Integration Keys',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in Google Cloud Console and update SST Secrets',
  },
  GITHUB_CLIENT_SECRET: {
    description: 'OAuth Integration Keys',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in GitHub Developer Settings and update SST Secrets',
  },
  OKTA_CLIENT_SECRET: {
    description: 'OAuth Integration Keys',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in Okta Admin Console and update SST Secrets',
  },

  // ── Payment Processing ─────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: {
    description: 'Payment Processing',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new key in Stripe Dashboard and update SST Secret',
  },
  STRIPE_PUBLISHABLE_KEY: {
    description: 'Payment Processing',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new key in Stripe Dashboard and update SST Secret',
  },
  STRIPE_WEBHOOK_SECRET: {
    description: 'Payment Processing',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Update webhook endpoint in Stripe and update SST Secret',
  },

  // ── Email Service ──────────────────────────────────────────────────────────
  // Replaces the drifted SMTP_CREDENTIALS entry (no SST secret by that name exists).
  MAIL_HOST: {
    description: 'Email Service — SMTP host',
    rotationIntervalDays: 365,
    isAutomatic: false,
    rotationProcess: 'Update SMTP host in email provider settings and update SST Secret',
  },
  MAIL_PORT: {
    description: 'Email Service — SMTP port',
    rotationIntervalDays: 365,
    isAutomatic: false,
    rotationProcess: 'Update SMTP port in email provider settings and update SST Secret',
  },
  MAIL_USERNAME: {
    description: 'Email Service — SMTP username',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Rotate credentials in email provider and update SST Secret',
  },
  MAIL_PASSWORD: {
    description: 'Email Service — SMTP password',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Rotate credentials in email provider and update SST Secret',
  },
  MAIL_FROM: {
    description: 'Email Service — sender address',
    rotationIntervalDays: 365,
    isAutomatic: false,
    rotationProcess: 'Update sender address in email provider settings and update SST Secret',
  },

  // ── External AI/LLM API Keys ───────────────────────────────────────────────
  ANTHROPIC_API_KEY: {
    description: 'Anthropic Claude API key (system fallback; primary path uses per-user keys)',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Generate new key in Anthropic console and update SST Secret',
  },
  // GEMINI_API_KEY is wired through config plumbing and the System Secrets GUI for
  // fork deployments, but the live LLM adapter path reads adminSettings.geminiDemoKey,
  // not this SST secret directly. Left as-is pending a decision on whether to wire it
  // into the geminiDemoKey AdminSettings seeding flow or remove it.
  GEMINI_API_KEY: {
    description: 'Google Gemini API key',
    rotationIntervalDays: 90,
    isAutomatic: false,
    rotationProcess: 'Generate new key in Google AI Studio and update SST Secret',
  },

  // ── Slack ──────────────────────────────────────────────────────────────────
  // Replaces the drifted SLACK_WEBHOOK_URLS entry (no SST secret by that name exists).
  SLACK_WEBHOOK_URL: {
    description: 'Slack webhook for primary notifications',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Regenerate webhook URL in Slack app settings and update SST Secret',
  },
  SLACK_ERROR_REPORTING_WEBHOOK_URL: {
    description: 'Slack webhook for error reporting notifications',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Regenerate webhook URL in Slack app settings and update SST Secret',
  },
  SLACK_SIGNING_SECRET: {
    description: 'Slack app signing secret for request verification',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in Slack app settings (Basic Information) and update SST Secret',
  },
  SLACK_CLIENT_SECRET: {
    description: 'Slack OAuth app client secret',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in Slack app settings (Basic Information) and update SST Secret',
  },

  // ── Application Keys ───────────────────────────────────────────────────────
  B4M_PROD_API_KEY: {
    description: 'Production API key',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new key and update SST Secret',
  },
  NPM_TOKEN: {
    description: 'npm access token for private package publishing',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token in npm account settings and update SST Secret',
  },

  // ── OptiHashi Compute Integration ──────────────────────────────────────────
  OPTIHASHI_API_TOKEN: {
    description: 'OptiHashi external-compute API token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in the compute provider dashboard and update SST Secret',
  },
  OPTIHASHI_WEBHOOK_SECRET: {
    description: 'OptiHashi compute webhook signing secret',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess:
      'Copy current value to OPTIHASHI_WEBHOOK_SECRET_PREVIOUS, generate new secret, update webhook in the compute provider dashboard, then update SST Secret',
  },

  // ── Third-party Integrations ───────────────────────────────────────────────
  GA_SERVICE_ACCOUNT_KEY: {
    description: 'Google Analytics Data API service account key (base64-encoded JSON)',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Create new service account key in GCP console, base64-encode, update SST Secret, delete old key',
  },
  LINKEDIN_CLIENT_SECRET: {
    description: 'LinkedIn OAuth app client secret',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Rotate in LinkedIn developer portal and update SST Secret',
  },

  // ── SecOps Ingest / Dispatch / Workflow Tokens ─────────────────────────────
  SECOPS_ZAP_DISPATCH_TOKEN: {
    description: 'SecOps — OWASP ZAP scan dispatch token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_ZAP_INGEST_TOKEN: {
    description: 'SecOps — OWASP ZAP result ingest token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_CODE_INGEST_TOKEN: {
    description: 'SecOps — code analysis (Semgrep) ingest token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_PACKAGES_INGEST_TOKEN: {
    description: 'SecOps — package scan ingest token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_PACKAGES_DISPATCH_TOKEN: {
    description: 'SecOps — package scan dispatch token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_SECRETS_INGEST_TOKEN: {
    description: 'SecOps — secrets scan ingest token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_SECRETS_DISPATCH_TOKEN: {
    description: 'SecOps — secrets scan dispatch token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_PROWLER_INGEST_TOKEN: {
    description: 'SecOps — Prowler cloud scan ingest token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret + corresponding GitHub secret',
  },
  SECOPS_PROWLER_WORKFLOW_TOKEN: {
    description: 'SecOps — GitHub PAT (workflow scope) for dispatching Prowler scans',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new PAT at github.com/settings/tokens with workflow scope and update SST Secret',
  },
  SECOPS_ATTACK_SIMULATION_INGEST_TOKEN: {
    description: 'SecOps — active defense attack simulation ingest token',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new token and update SST Secret',
  },

  // ── Internal Service Tokens ────────────────────────────────────────────────
  RATE_LIMIT_INGEST_TOKEN: {
    description: 'Shared secret for authenticating rate limit ingest requests from MCP Lambda',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new random token and update SST Secret',
  },
  E2E_CLEANUP_SECRET: {
    description: 'Shared secret for E2E test cleanup endpoints (/api/test/create-user, /api/test/cleanup)',
    rotationIntervalDays: 180,
    isAutomatic: false,
    rotationProcess: 'Generate new random token and update SST Secret via set-sst-secrets workflow',
  },
};
