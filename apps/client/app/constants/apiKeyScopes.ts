import { ApiKeyScope } from '@bike4mind/common';

export interface ApiKeyScopeOption {
  value: ApiKeyScope;
  label: string;
  description: string;
  endpoints: string[];
}

/**
 * Single source of truth for the API key scopes a user can self-select when
 * creating a key (profile + admin modals + the Scopes documentation tab).
 *
 * Intentionally excludes the privileged `ApiKeyScope.ADMIN` (`admin:*`) and the
 * bridge-only `ApiKeyScope.CC_BRIDGE` (`cc-bridge:connect`), which are granted
 * through dedicated flows, not user-facing key creation.
 */
export const USER_API_KEY_SCOPES: ApiKeyScopeOption[] = [
  {
    value: ApiKeyScope.READ_NOTEBOOKS,
    label: 'Read Notebooks',
    description: 'View notebooks and sessions',
    endpoints: ['GET /api/sessions', 'GET /api/sessions/:id'],
  },
  {
    value: ApiKeyScope.WRITE_NOTEBOOKS,
    label: 'Write Notebooks',
    description: 'Create and modify notebooks',
    endpoints: ['POST /api/sessions/create', 'PUT /api/sessions/:id'],
  },
  {
    value: ApiKeyScope.READ_FILES,
    label: 'Read Files',
    description: 'Download and view files',
    endpoints: ['GET /api/files', 'GET /api/files/:id'],
  },
  {
    value: ApiKeyScope.WRITE_FILES,
    label: 'Write Files',
    description: 'Upload and modify files',
    endpoints: ['POST /api/files', 'PUT /api/files/:id'],
  },
  {
    value: ApiKeyScope.AI_GENERATE,
    label: 'AI Generate',
    description: 'Use AI generation features',
    endpoints: ['POST /api/ai/generate-image'],
  },
  {
    value: ApiKeyScope.AI_CHAT,
    label: 'AI Chat',
    description: 'Use AI chat features',
    endpoints: ['POST /api/ai/llm'],
  },
  {
    value: ApiKeyScope.READ_PROJECTS,
    label: 'Read Projects',
    description: 'View projects',
    endpoints: ['GET /api/projects'],
  },
  {
    value: ApiKeyScope.WRITE_PROJECTS,
    label: 'Write Projects',
    description: 'Create and modify projects',
    endpoints: ['POST /api/projects', 'PUT /api/projects/:id'],
  },
  {
    value: ApiKeyScope.MARKETING_REPORTS_READ,
    label: 'Marketing Reports: Read',
    description: 'Read published marketing reports',
    endpoints: ['GET /api/overwatch/marketing-reports', 'GET /api/overwatch/marketing-reports/:id'],
  },
  {
    value: ApiKeyScope.MARKETING_REPORTS_WRITE,
    label: 'Marketing Reports: Write',
    description: 'Create and update marketing reports',
    endpoints: ['POST /api/overwatch/marketing-reports', 'PUT /api/overwatch/marketing-reports/:id'],
  },
];

/** All user-selectable scope values, e.g. for a "Select All" action. */
export const USER_API_KEY_SCOPE_VALUES: ApiKeyScope[] = USER_API_KEY_SCOPES.map(s => s.value);

/**
 * Scopes that are provisioned by admins only and must never appear in the user-facing
 * key creation UI. The ingest scope is excluded from USER_API_KEY_SCOPES by design.
 */
export const ADMIN_ONLY_API_KEY_SCOPES: ApiKeyScopeOption[] = [
  {
    value: ApiKeyScope.OVERWATCH_INGEST_WRITE,
    label: 'Overwatch: Ingest',
    description: 'Server-to-server event ingestion for Overwatch analytics',
    endpoints: ['POST /api/overwatch/v1/events'],
  },
];
