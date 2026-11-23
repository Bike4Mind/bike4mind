import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CENSUS_FIELDS, censusLabel } from './credential-census-report';
import { SWEEP_FIELDS, sweepLabel } from './reencrypt-stored-secrets-sweep';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const sweepLabels = new Set(SWEEP_FIELDS.map(sweepLabel));

const FIX =
  'add the stored field to SWEEP_FIELDS in reencrypt-stored-secrets-sweep.ts, then record the call site in REVIEWED_ENCRYPT_SITES';

describe('re-encrypt sweep coverage of the credential census', () => {
  it('sweeps every census field that holds ciphertext', () => {
    const missing = CENSUS_FIELDS.filter(field => field.format === 'ciphertext' || field.format === 'bound-ciphertext')
      .map(censusLabel)
      .filter(label => !sweepLabels.has(label));
    expect(missing, `census fields missing from SWEEP_FIELDS: add them in reencrypt-stored-secrets-sweep.ts`).toEqual(
      []
    );
  });

  it('leaves out the formats this command cannot re-encrypt', () => {
    const other = CENSUS_FIELDS.filter(field => field.format === 'bcrypt' || field.format === 'wrapped-dek');
    expect(other.length).toBeGreaterThan(0);
    for (const field of other) expect(sweepLabels.has(censusLabel(field)), censusLabel(field)).toBe(false);
  });
});

const MCP_ENV = 'mcpservers.envVariables[].value';
const MCP_GITHUB_WEBHOOK = 'mcpservers.metadata.webhooks.github.secret';
const ATLASSIAN = ['users.atlassianConnect.accessToken', 'users.atlassianConnect.refreshToken'] as const;
const GOOGLE_DRIVE = ['users.googleDrive.accessToken', 'users.googleDrive.refreshToken'] as const;
const PROVIDER_TOKENS = [
  'users.authProviders[].accessToken',
  'users.authProviders[].refreshToken',
  'users.oauthCredentials.accessToken',
  'users.oauthCredentials.refreshToken',
] as const;
const SLACK_APP_SECRETS = [
  'slackdevworkspaces.slackClientSecret',
  'slackdevworkspaces.slackOAuthSigningSecret',
  'slackdevworkspaces.slackVerificationToken',
  'slackdevworkspaces.appConfigurationToken',
] as const;
const IDENTITY_PROVIDER = [
  'identityproviders.samlConfig.decryptionPvk',
  'identityproviders.samlConfig.privateCert',
  'identityproviders.oktaConfig.clientSecret',
] as const;
const GITHUB_CONNECTION_KEY = 'orggithubconnections.privateKey';
const GITHUB_CONNECTION_PAT = 'orggithubconnections.accessToken';
const SETTING_VALUE = 'adminsettings.settingValue';
const API_KEY = 'apikeys.apiKey';
const ORG_WEBHOOK_SECRET = 'orgwebhookconfigs.secret';
const MFA_TOTP = 'users.mfa.totpSecret';
const MFA_BACKUP_CODES = 'users.mfa.pendingBackupCodes';
const USER_API_KEY_SECRET = 'userapikeys.callbackSigningSecret';
const MCP_OAUTH_ACCESS = 'mcpconnections.auth.oauth.accessTokenEnc';
const MCP_OAUTH_REFRESH = 'mcpconnections.auth.oauth.refreshTokenEnc';
const SLACK_USER_TOKEN = 'users.slackSettings.slackUserToken';
const BLOG_API_KEY = 'users.blogIntegration.apiKey';
const ORG_SLACK_BOT = 'orgslackworkspaces.slackBotToken';
const DEV_SLACK_BOT = 'slackdevworkspaces.slackBotToken';

/** file -> how many encrypt calls it holds and which sweep labels those calls write. */
const REVIEWED_ENCRYPT_SITES: Record<string, { calls: number; writes: readonly string[]; note?: string }> = {
  'apps/client/pages/api/admin/github/connection.ts': {
    calls: 2,
    writes: [GITHUB_CONNECTION_KEY, GITHUB_CONNECTION_PAT],
  },
  'apps/client/pages/api/admin/github/rotate-key.ts': { calls: 1, writes: [GITHUB_CONNECTION_KEY] },
  'apps/client/pages/api/admin/system-secrets/index.ts': { calls: 1, writes: ['systemsecrets.encryptedValue'] },
  'apps/client/pages/api/auth/github/mcp-callback.ts': { calls: 1, writes: [MCP_ENV] },
  'apps/client/pages/api/auth/okta/callback.ts': {
    calls: 2,
    writes: PROVIDER_TOKENS,
    note: 'The sealed tokens are stored under both authProviders and oauthCredentials.',
  },
  'apps/client/pages/api/blog-integration/index.ts': { calls: 1, writes: [BLOG_API_KEY] },
  'apps/client/pages/api/google-drive/callback.ts': { calls: 2, writes: GOOGLE_DRIVE },
  'apps/client/pages/api/google-drive/token.ts': { calls: 2, writes: GOOGLE_DRIVE },
  'apps/client/pages/api/mcp-servers/[id]/index.ts': { calls: 1, writes: [MCP_ENV] },
  'apps/client/pages/api/mcp-servers/[id]/webhooks/github.ts': { calls: 1, writes: [MCP_GITHUB_WEBHOOK] },
  'apps/client/pages/api/mcp-servers/[id]/webhooks/github/secret.ts': { calls: 1, writes: [MCP_GITHUB_WEBHOOK] },
  'apps/client/pages/api/mcp-servers/atlassian/callback.ts': { calls: 2, writes: ATLASSIAN },
  'apps/client/pages/api/mcp-servers/atlassian/finalize.ts': { calls: 1, writes: [MCP_ENV] },
  'apps/client/pages/api/mcp-servers/atlassian/refresh.ts': { calls: 3, writes: [...ATLASSIAN, MCP_ENV] },
  'apps/client/pages/api/mcp-servers/index.ts': { calls: 1, writes: [MCP_ENV] },
  'apps/client/pages/api/mcp-servers/notion/callback.ts': { calls: 1, writes: ['users.notionConnect.accessToken'] },
  'apps/client/pages/api/mcp-servers/notion/settings.ts': { calls: 1, writes: [MCP_ENV] },
  'apps/client/pages/api/organizations/[id]/github/connection.ts': {
    calls: 2,
    writes: [GITHUB_CONNECTION_KEY, GITHUB_CONNECTION_PAT],
  },
  'apps/client/pages/api/organizations/[id]/github/rotate-key.ts': { calls: 1, writes: [GITHUB_CONNECTION_KEY] },
  'apps/client/pages/api/organizations/[id]/github/rotate-pat.ts': { calls: 1, writes: [GITHUB_CONNECTION_PAT] },
  'apps/client/pages/api/organizations/[id]/webhooks/github.ts': { calls: 1, writes: [ORG_WEBHOOK_SECRET] },
  'apps/client/pages/api/organizations/[id]/webhooks/github/rotate-secret.ts': {
    calls: 1,
    writes: [ORG_WEBHOOK_SECRET],
  },
  'apps/client/pages/api/settings/update.ts': {
    calls: 2,
    writes: [SETTING_VALUE],
    note: 'One call encrypts a sensitive string setting, the other each per-repo secret of the object-valued setting.',
  },
  'apps/client/pages/api/slack/oauth/org-connect/callback.ts': { calls: 2, writes: [ORG_SLACK_BOT] },
  'apps/client/pages/api/slack/oauth/user-link/callback.ts': { calls: 1, writes: [SLACK_USER_TOKEN] },
  'apps/client/pages/api/webhooks/jira/config/index.ts': {
    calls: 2,
    writes: ['jirawebhookconfigs.secret'],
    note: 'Create and rotate; the rotation copies the old stored secret to previousSecret unchanged.',
  },
  'apps/client/server/auth/appleStrategy.ts': {
    calls: 2,
    writes: PROVIDER_TOKENS,
    note: 'The sealed tokens are stored under both authProviders and oauthCredentials.',
  },
  'apps/client/server/auth/oauthServer.ts': { calls: 1, writes: ['systemsecrets.encryptedValue'] },
  'apps/client/server/integrations/notion/notionTokenManager.ts': { calls: 1, writes: [MCP_ENV] },
  'apps/client/server/mcpConnections/connectionService.ts': {
    calls: 2,
    writes: ['mcpconnections.auth.apiKey.valueEnc'],
  },
  'apps/client/server/mcpConnections/connectionUrl.ts': { calls: 1, writes: ['mcpconnections.urlEnc'] },
  'apps/client/server/mcpConnections/oauth/completeOAuth.ts': {
    calls: 2,
    writes: [MCP_OAUTH_ACCESS, MCP_OAUTH_REFRESH],
  },
  'apps/client/server/mcpConnections/oauth/startOAuth.ts': { calls: 1, writes: ['mcpoauthpendings.codeVerifierEnc'] },
  'apps/client/server/utils/auth/providerTokensAtRest.ts': {
    calls: 2,
    writes: PROVIDER_TOKENS,
    note: 'sealProviderTokens feeds the sign-in write to both authProviders and oauthCredentials.',
  },
  'apps/client/server/validators/mcpServerValidators.ts': {
    calls: 1,
    writes: [],
    note: 'The match is the name encryptEnvVariables() inside a comment; nothing is encrypted here.',
  },
  'b4m-core/services/src/userApiKeyService/create.ts': { calls: 1, writes: [USER_API_KEY_SECRET] },
  'b4m-core/slack/src/di/types.ts': {
    calls: 1,
    writes: [],
    note: 'Declares encryptToken on the ITokenEncryption interface; stores nothing.',
  },
  'b4m-core/slack/src/installer.ts': { calls: 1, writes: [DEV_SLACK_BOT] },
  'b4m-core/utils/src/security/secretEncryption.ts': {
    calls: 2,
    writes: [],
    note: 'Defines encryptSecret and calls it inside rotateSecret; the callers of both are listed in this table.',
  },
  'b4m-core/utils/src/security/secretsAtRest.ts': {
    calls: 2,
    writes: [],
    note: 'Defines encryptAtRest, which calls encryptSecret; the callers of encryptAtRest are listed in this table.',
  },
  'packages/database/src/models/auth/ApiKeyModel.ts': { calls: 1, writes: [API_KEY] },
  'packages/database/src/models/auth/IdentityProviderModel.ts': { calls: 2, writes: IDENTITY_PROVIDER },
  'packages/database/src/models/auth/UserApiKeyModel.ts': { calls: 1, writes: [USER_API_KEY_SECRET] },
  'packages/database/src/models/auth/UserModel.ts': { calls: 3, writes: [MFA_TOTP, MFA_BACKUP_CODES] },
  'packages/database/src/models/infra/integrations/SlackDevWorkspaceModel.ts': {
    calls: 1,
    writes: SLACK_APP_SECRETS,
    note: 'The schema setter shared by the four app credential fields.',
  },
  'packages/scripts/migrate/encrypt-admin-settings-and-apikeys.ts': {
    calls: 2,
    writes: [SETTING_VALUE, API_KEY],
    note: 'Backfill of plaintext values.',
  },
  'packages/scripts/migrate/encrypt-tokens-at-rest.ts': {
    calls: 2,
    writes: [
      ...ATLASSIAN,
      ...GOOGLE_DRIVE,
      SLACK_USER_TOKEN,
      BLOG_API_KEY,
      MCP_ENV,
      MCP_GITHUB_WEBHOOK,
      ORG_SLACK_BOT,
      DEV_SLACK_BOT,
    ],
    note: 'Backfill of plaintext values.',
  },
  'packages/scripts/migrate/migrations/20260904000000_encrypt-identity-provider-secrets.ts': {
    calls: 1,
    writes: IDENTITY_PROVIDER,
    note: 'Backfill of plaintext values.',
  },
  'packages/scripts/migrate/migrations/20260921235955_encrypt-sensitive-admin-settings.ts': {
    calls: 1,
    writes: [SETTING_VALUE],
    note: 'Backfill of plaintext values.',
  },
  'packages/scripts/migrate/migrations/20260921240020_encrypt-oauth-provider-tokens.ts': {
    calls: 2,
    writes: PROVIDER_TOKENS,
    note: 'Backfill of plaintext values.',
  },
  'packages/scripts/migrate/protect-stored-credentials-backfill.ts': {
    calls: 5,
    writes: [MFA_TOTP, API_KEY, MCP_ENV, ...SLACK_APP_SECRETS, 'secretrotations.previousKey'],
    note: 'Backfill of plaintext values.',
  },
  'packages/server-utils/src/integrations/github/dataLake/githubLakeAuthGrant.ts': {
    calls: 1,
    writes: ['githublakeauthgrants.encryptedToken'],
  },
  'packages/server-utils/src/integrations/google/drive/common.ts': { calls: 2, writes: GOOGLE_DRIVE },
  'packages/server-utils/src/integrations/jira/atlassianTokenManager.ts': { calls: 3, writes: [...ATLASSIAN, MCP_ENV] },
  'packages/server-utils/src/mcpConnections/oauth/clientIdentity.ts': {
    calls: 3,
    writes: [
      'mcpconnections.auth.oauth.manualClientIdEnc',
      'mcpconnections.auth.oauth.manualClientSecretEnc',
      'mcpoauthclientregistrations.clientSecretEnc',
    ],
  },
  'packages/server-utils/src/mcpConnections/oauth/tokenManager.ts': {
    calls: 2,
    writes: [MCP_OAUTH_ACCESS, MCP_OAUTH_REFRESH],
  },
  'packages/server-utils/src/security/tokenEncryption.ts': {
    calls: 4,
    writes: [],
    note: 'Defines encryptToken and encryptEnvVariables over encryptSecret; the callers are listed in this table.',
  },
  'packages/server-utils/src/services/githubService.ts': {
    calls: 1,
    writes: ['orggithubconnections.cachedAccessToken'],
  },
};

/** Sweep labels with no encrypt call in this repository, and why. */
const NO_ENCRYPT_CALL_IN_REPO: Record<string, string> = {
  'systemsecrets.previousEncryptedValue':
    'Verbatim copy of the replaced encryptedValue, made by the repository update.',
  'jirawebhookconfigs.previousSecret': 'Verbatim copy of the replaced secret, made by the webhook config rotation.',
  'orggoogledriveconnections.oauthRefreshToken': "Verbatim copy of the owning user's googleDrive.refreshToken.",
  'mcpoauthclientregistrations.registrationAccessTokenEnc':
    'The model declares the field; no code in this repository writes it.',
  'orgjiraconnections.accessToken': 'The model declares the field; no code in this repository writes it.',
  'overwatchsocialconnections.accessToken': 'Written by a connector outside this repository.',
  'overwatchsocialconnections.refreshToken': 'Written by a connector outside this repository.',
};

const ENCRYPT_CALL = /\b(encryptSecret|encryptAtRest|encryptToken|encryptEnvVariables)\(/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '__tests__', '__test__']);
const FIXED_ROOTS = [
  'apps/client/pages',
  'apps/client/server',
  'apps/workers/src',
  'packages/database/src',
  'packages/server-utils/src',
  'packages/scripts',
];

const scanRoots = (): string[] => [
  ...FIXED_ROOTS,
  ...readdirSync(join(REPO_ROOT, 'b4m-core'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `b4m-core/${entry.name}/src`),
];

/** Walks shippable source and counts encrypt calls per file. Prunes directories rather than filtering after. */
function scanEncryptSites(): Record<string, number> {
  const found: Record<string, number> = {};
  const walk = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(absolute, entry.name), path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        const calls = readFileSync(join(absolute, entry.name), 'utf8').match(ENCRYPT_CALL)?.length ?? 0;
        if (calls > 0) found[path] = calls;
      }
    }
  };
  for (const root of scanRoots()) {
    if (existsSync(join(REPO_ROOT, root))) walk(join(REPO_ROOT, root), root);
  }
  return found;
}

describe('re-encrypt sweep coverage of encrypt call sites', () => {
  const scanned = scanEncryptSites();

  it('has a reviewed entry for exactly the files that encrypt', () => {
    const reviewed = Object.fromEntries(
      Object.entries(REVIEWED_ENCRYPT_SITES).map(([file, site]) => [file, site.calls])
    );
    const problems = [
      ...Object.keys(scanned)
        .filter(file => !(file in reviewed))
        .map(file => `${file} has ${scanned[file]} encrypt call(s) that are not reviewed: ${FIX}`),
      ...Object.keys(scanned)
        .filter(file => file in reviewed && scanned[file] !== reviewed[file])
        .map(file => `${file} now has ${scanned[file]} encrypt call(s), the table says ${reviewed[file]}: ${FIX}`),
      ...Object.keys(reviewed)
        .filter(file => !(file in scanned))
        .map(file => `${file} no longer has an encrypt call: remove it from REVIEWED_ENCRYPT_SITES`),
    ];
    expect(problems).toEqual([]);
  });

  it('only names labels that exist in SWEEP_FIELDS', () => {
    for (const [file, site] of Object.entries(REVIEWED_ENCRYPT_SITES)) {
      for (const label of site.writes) {
        expect(sweepLabels.has(label), `${file} writes ${label}, which SWEEP_FIELDS does not list: ${FIX}`).toBe(true);
      }
    }
  });

  it('explains every entry that writes nothing', () => {
    for (const [file, site] of Object.entries(REVIEWED_ENCRYPT_SITES)) {
      if (site.writes.length === 0) expect(site.note?.trim(), `${file} writes nothing: say why in note`).toBeTruthy();
      expect(site.calls, file).toBeGreaterThan(0);
    }
  });

  it('writes every sweep label from a reviewed site, or says why none does', () => {
    const written = new Set(Object.values(REVIEWED_ENCRYPT_SITES).flatMap(site => site.writes));
    const unwritten = [...sweepLabels].filter(label => !written.has(label) && !(label in NO_ENCRYPT_CALL_IN_REPO));
    expect(unwritten, `no encrypt call writes these SWEEP_FIELDS labels: record the writer or add a reason`).toEqual(
      []
    );
  });

  it('keeps NO_ENCRYPT_CALL_IN_REPO to live labels that no reviewed site writes', () => {
    const written = new Set(Object.values(REVIEWED_ENCRYPT_SITES).flatMap(site => site.writes));
    for (const [label, reason] of Object.entries(NO_ENCRYPT_CALL_IN_REPO)) {
      expect(sweepLabels.has(label), `${label} is not in SWEEP_FIELDS`).toBe(true);
      expect(
        written.has(label),
        `${label} is now written by a reviewed site: drop it from NO_ENCRYPT_CALL_IN_REPO`
      ).toBe(false);
      expect(reason.trim(), label).not.toBe('');
    }
  });
});
