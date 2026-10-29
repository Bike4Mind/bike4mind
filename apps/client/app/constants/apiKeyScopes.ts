import {
  ApiKeyScope,
  type ApiKeyScopeValue,
  CONFINED_API_KEY_SCOPES,
  isBuiltInApiKeyScope,
  isWellFormedApiKeyScope,
} from '@bike4mind/common';
import type { PremiumApiKeyScope } from '@client/app/premiumContract';
import { premiumApiKeyScopes } from '@client/app/premium-generated/premiumApiKeyScopes.generated';

export interface ApiKeyScopeOption {
  value: ApiKeyScopeValue;
  label: string;
  description: string;
  endpoints: string[];
  /** Contributed rows only: the entitlement a viewer needs to be offered (and mint) the scope. */
  requiredEntitlement?: string;
}

/**
 * Single source of truth for the API key scopes a user can self-select when
 * creating a key (profile + admin modals + the Scopes documentation tab).
 *
 * Intentionally excludes the privileged `ApiKeyScope.ADMIN` (`admin:*`) and the
 * bridge-only `ApiKeyScope.CC_BRIDGE` (`cc-bridge:connect`), which are granted
 * through dedicated flows, not user-facing key creation.
 *
 * `embed:chat` is a member of this catalog (the source of truth for the scope) but
 * is a dedicated-flow scope: it is filtered out of the generic New-Key modals AND
 * the Scopes docs tab (via GENERIC_MODAL_API_KEY_SCOPES) until its mint flow ships,
 * because an embed key needs an agentId + origin allow-list those surfaces do not
 * collect and its endpoint lands in Phase B. Embed keys are minted through the
 * dedicated embed flow (epic #41 Phase E), not here.
 *
 * Built-in rows only; USER_API_KEY_SCOPES adds the rows premium overlays contribute.
 */
const BUILT_IN_USER_API_KEY_SCOPES: ApiKeyScopeOption[] = [
  {
    value: ApiKeyScope.READ_NOTEBOOKS,
    label: 'Read Notebooks',
    description: 'View notebooks and sessions',
    endpoints: [
      'GET /api/sessions',
      'GET /api/sessions/:id',
      'GET /api/v1/quests/:id',
      'GET /api/v1/quests/:id/files',
      'GET /api/v1/artifacts',
      'GET /api/v1/artifacts/:id',
      'GET /api/v1/artifacts/:id/versions',
      'GET /api/v1/artifacts/:id/versions/:version',
    ],
  },
  {
    value: ApiKeyScope.WRITE_NOTEBOOKS,
    label: 'Write Notebooks',
    description: 'Create and modify notebooks',
    endpoints: [
      'POST /api/v1/sessions',
      'GET /api/sessions/:id',
      'PUT /api/sessions/:id',
      'DELETE /api/sessions/:id',
      'POST /api/v1/artifacts',
      'GET /api/v1/artifacts',
      'GET /api/v1/artifacts/:id',
      'PATCH|DELETE /api/v1/artifacts/:id',
      'GET /api/v1/artifacts/:id/versions',
      'GET /api/v1/artifacts/:id/versions/:version',
    ],
  },
  {
    value: ApiKeyScope.READ_FILES,
    label: 'Read Files',
    description: 'Download and view files',
    endpoints: ['GET /api/v1/files', 'GET /api/v1/files/:id'],
  },
  {
    value: ApiKeyScope.WRITE_FILES,
    label: 'Write Files',
    description: 'Upload and modify files',
    endpoints: [
      'POST /api/v1/files',
      'PATCH|DELETE /api/v1/files/:id',
      'POST /api/files/createFabFile (datalake:write to tag into a lake)',
    ],
  },
  {
    value: ApiKeyScope.AI_GENERATE,
    label: 'AI Generate',
    description: 'Use AI generation features',
    endpoints: [
      'POST /api/v1/sessions',
      'POST /api/v1/image-generations',
      'POST /api/v1/image-edits',
      'POST /api/v1/video-generations',
      'GET /api/v1/video-generations',
      'GET /api/v1/video-generations/:id',
      'POST /api/v1/video-generations/:id/cancel',
      'GET /api/v1/video-models',
      'POST /api/v1/music-generations',
      'GET /api/v1/music-generations',
      'GET /api/v1/music-generations/:id',
      'POST /api/v1/music-generations/:id/cancel',
      'GET /api/v1/music-models',
      'POST /api/v1/embeddings',
      'POST /api/v1/text-refinements',
      'POST /api/v1/decisions',
      'GET /api/v1/decision-models',
      'GET /api/v1/voice/voices',
      'POST /api/v1/voice/sessions',
      'POST /api/v1/voice/sessions/:id/end',
      'POST /api/v1/transcriptions/uploads',
      'POST /api/v1/transcriptions',
      'GET /api/v1/quests/:id',
      'GET /api/v1/quests/:id/files',
      'GET /api/v1/credits',
      'GET /api/v1/models',
    ],
  },
  {
    value: ApiKeyScope.AI_DECIDE,
    label: 'AI Decide',
    description: 'Answer yes/no, pick-one and rating questions with probabilities',
    endpoints: ['POST /api/v1/decisions', 'GET /api/v1/decision-models', 'GET /api/v1/credits'],
  },
  {
    value: ApiKeyScope.AI_CHAT,
    label: 'AI Chat',
    description: 'Use AI chat features',
    endpoints: [
      'POST /api/ai/llm',
      'GET /api/v1/quests/:id',
      'GET /api/v1/quests/:id/files',
      'GET /api/v1/credits',
      'GET /api/v1/models',
    ],
  },
  {
    value: ApiKeyScope.READ_PROJECTS,
    label: 'Read Projects',
    description: 'View projects',
    endpoints: [
      'GET /api/projects',
      'GET /api/projects/:id',
      'GET /api/projects/:id/files',
      'GET /api/projects/:id/sessions',
      'GET /api/projects/:id/invites',
      'GET /api/v1/projects',
      'GET /api/v1/projects/:id',
    ],
  },
  {
    value: ApiKeyScope.WRITE_PROJECTS,
    label: 'Write Projects',
    description: 'Create, modify, share and delete projects',
    endpoints: [
      'POST /api/projects',
      'PUT /api/projects/:id',
      'DELETE /api/projects/:id',
      'POST|DELETE /api/projects/:id/files',
      'POST|DELETE /api/projects/:id/sessions',
      'POST /api/projects/:id/invites',
      'DELETE /api/projects/:id/members',
      'POST|DELETE /api/projects/:id/systemPrompts',
      'POST /api/projects/:id/systemPrompts/toggle',
      'DELETE /api/projects/removeNonExistintFiles',
      'POST /api/v1/projects',
      'GET /api/v1/projects',
      'GET /api/v1/projects/:id',
      'PATCH|DELETE /api/v1/projects/:id',
    ],
  },
  {
    value: ApiKeyScope.READ_AGENTS,
    label: 'Read Agents',
    description: 'View agents',
    endpoints: [
      'GET /api/agents',
      'GET /api/agents/:id',
      'GET /api/agents/:id/missions',
      'GET /api/v1/agents',
      'GET /api/v1/agents/:id',
    ],
  },
  {
    value: ApiKeyScope.WRITE_AGENTS,
    label: 'Write Agents',
    description: 'Create, modify, fund and delete agents, and run the agent-authoring assistants',
    endpoints: [
      'POST /api/agents',
      'PUT /api/agents/:id',
      'DELETE /api/agents/:id',
      'POST /api/agents/create-from-context',
      'POST /api/agents/:id/missions',
      'POST /api/agents/:id/transfer-credits',
      'GET /api/agents/:id/embed-keys',
      'POST /api/agents/:id/generate-avatar',
      'POST /api/agents/:id/generate-description',
      'POST /api/agents/:id/generate-system-prompt',
      'POST /api/agents/:id/enhance-field',
      'POST /api/v1/agents',
      'GET /api/v1/agents',
      'GET /api/v1/agents/:id',
      'PATCH|DELETE /api/v1/agents/:id',
      'POST /api/v1/agents/:id/generate-avatar',
      'POST /api/v1/agents/:id/generate-description',
      'POST /api/v1/agents/:id/generate-system-prompt',
      'POST /api/v1/agents/:id/enhance-field',
    ],
  },
  {
    value: ApiKeyScope.ME_READ,
    label: 'Account: Read',
    // Keep in sync with the me:read consent label in app/routes/oauth/consentScopes.ts.
    description: "Read the key owner's own name, plan tier, subscription, credit balance, and entitlements",
    endpoints: ['GET /api/v1/me', 'GET /api/v1/credits'],
  },
  {
    value: ApiKeyScope.SKILLS_READ,
    label: 'Skill Market: Claude Code feed',
    // Confined, so it is minted from the Skill Market's "Use in Claude Code" dialog, not the New-Key modals.
    description:
      "Read the Claude Code plugin marketplace of an organization's approved Skill Market listings, and browse and read listings",
    endpoints: [
      'GET /api/v1/skills/market/claude-marketplace.json',
      'GET /api/v1/skills/market/:id/claude-plugin.zip',
      'GET /api/v1/skills/market/listings',
      'GET /api/v1/skills/market/listings/:id',
    ],
  },
  {
    value: ApiKeyScope.SKILLS_WRITE,
    label: 'Skill Market: Write',
    description:
      'Publish your skills to the Skill Market, submit new versions, manage and withdraw your listings, and browse and import listings. Unlike skills:read, it is not confined: it also reaches API routes that declare no scope',
    endpoints: [
      'GET|POST /api/v1/skills/market/listings',
      'GET /api/v1/skills/market/listings/mine',
      'GET|DELETE /api/v1/skills/market/listings/:id',
      'POST /api/v1/skills/market/listings/:id/versions',
      'POST /api/v1/skills/market/listings/:id/import',
      'POST /api/v1/skills/market/versions/:vid/rescan',
    ],
  },
  {
    value: ApiKeyScope.SKILLS_REVIEW,
    label: 'Skill Market: Review',
    description:
      "Review your organizations' held Skill Market versions: list the review queue and approve or reject (org admins only)",
    endpoints: ['GET /api/v1/skills/market/review-queue', 'POST /api/v1/skills/market/versions/:vid/review'],
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
  {
    value: ApiKeyScope.EMBED_CHAT,
    label: 'Embedded Agent Chat',
    description: 'Chat with a single bound agent from an embedded widget on an allow-listed site',
    endpoints: ['POST /api/embed/chat'],
  },
  {
    value: ApiKeyScope.HEARTH_READ,
    label: 'Hearth: Read',
    description: 'List Hearth channels and replay their events without advancing any cursor',
    endpoints: ['GET /api/hearth/channels', 'POST /api/hearth/catchup'],
  },
  {
    value: ApiKeyScope.HEARTH_WRITE,
    label: 'Hearth: Write',
    description: 'Append Hearth events, create channels, and advance actor cursors',
    endpoints: ['POST /api/hearth/events', 'POST /api/hearth/channels', 'POST /api/hearth/catchup'],
  },
  {
    value: ApiKeyScope.OPTIHASHI_READ,
    label: 'OptiHashi: Read',
    description: 'Inspect OptiHashi problems, runs, and run artifacts without commissioning any compute',
    endpoints: ['OptiHashi run and problem reads'],
  },
  {
    value: ApiKeyScope.OPTIHASHI_COMPUTE,
    label: 'OptiHashi: Compute',
    description: 'Submit OptiHashi compute runs and cancel them. Spends credits - grant only to keys that must solve',
    endpoints: ['OptiHashi run submit and cancel'],
  },
  {
    value: ApiKeyScope.DATALAKE_READ,
    label: 'Data Lakes: Read',
    description: 'List and browse data lakes the key owner can already reach',
    endpoints: [
      'GET /api/v1/data-lakes',
      'GET /api/v1/data-lakes/:id',
      'GET /api/v1/data-lakes/:id/files/:file_id',
      'GET /api/data-lakes',
      'GET /api/data-lakes/:id',
    ],
  },
  {
    value: ApiKeyScope.DATALAKE_QUERY,
    label: 'Data Lakes: Query',
    description:
      'Run a retrieval query against a lake, and read lakes to support it. Spends credits - not part of the Read-only preset',
    endpoints: ['POST /api/data-lakes/semantic-search', 'POST /api/data-lakes/rlm-answer'],
  },
  {
    value: ApiKeyScope.DATALAKE_WRITE,
    label: 'Data Lakes: Write',
    description: 'Create and update lakes, and attach, retag, or remove their files',
    endpoints: ['POST /api/data-lakes', 'PUT /api/data-lakes/:id', 'POST /api/data-lakes/:id/files/:fabFileId'],
  },
  {
    value: ApiKeyScope.DATALAKE_SHARE,
    label: 'Data Lakes: Share',
    description:
      'Change who can reach a lake - its visibility and its ownership. Not implied by write: grant only to keys that must re-share',
    endpoints: [
      'POST /api/data-lakes/:id/visibility',
      'POST /api/data-lakes/:id/transfer-ownership',
      'DELETE /api/data-lakes/:id/transfer-ownership',
      'POST /api/data-lakes/ownership-offers/:offerId/accept',
      'POST /api/data-lakes/ownership-offers/:offerId/decline',
      'DELETE /api/organizations/:id',
      'DELETE /api/organizations/:id/members',
      'DELETE /api/organizations/:id/members/:userId',
    ],
  },
  {
    value: ApiKeyScope.OVERWATCH_READ,
    label: 'Overwatch: Read',
    description:
      'Explore the Overwatch analytics surface read-only - overview, products, metrics, funnel, pipeline freshness. Grants no ability to report stats or publish anything',
    endpoints: [
      'GET /api/premium-overwatch/agent/overview',
      'GET /api/premium-overwatch/agent/products',
      'GET /api/premium-overwatch/agent/products/:productId',
      'GET /api/premium-overwatch/agent/timeseries',
      'POST /api/premium-overwatch/agent/mcp',
    ],
  },
  {
    value: ApiKeyScope.BOB_READ,
    label: 'Bob: Read',
    description:
      "Read the key owner's own Bob reports - site reads, comparisons and re-checks - plus the recent-reports list and runs left. Starts nothing and spends no credits",
    endpoints: ['GET /api/premium-bob/bob-run', 'GET /api/premium-bob/bob-compare', 'GET /api/premium-bob/bob-recheck'],
  },
  {
    value: ApiKeyScope.BOB_RUN,
    label: 'Bob: Run',
    description:
      "Start a Bob site read, a two-site comparison or a re-check. Spends the key owner's credits and publishes a report as them - grant only to keys that must run",
    endpoints: [
      'POST /api/premium-bob/bob-run',
      'POST /api/premium-bob/bob-compare',
      'POST /api/premium-bob/bob-recheck',
    ],
  },
];

export interface MergeContributedScopesOptions {
  onReject?: (reason: string) => void;
}

// Same list as the codegen's RESERVED_API_KEY_SCOPE_RESOURCES (scripts/generate-premium-glue.mjs),
// re-checked here so a hand-edited generated file cannot add a scope under them. Only the checks
// that guard escalation repeat at load; text length caps and endpoint format are codegen-only.
const RESERVED_API_KEY_SCOPE_RESOURCES: ReadonlySet<string> = new Set(['admin', 'cc-bridge', 'embed', 'datalake']);

const sameEndpoints = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((endpoint, i) => endpoint === b[i]);

/**
 * `builtIn` plus the contributed rows. A contribution that repeats an existing row's label,
 * description and endpoints collapses onto it, and a built-in row keeps its own gate. Any other
 * contribution naming an existing value, a built-in scope or a reserved resource, and any malformed
 * row, is dropped and reported through `onReject`. This runs at module load, so it never throws.
 */
export function mergeContributedScopes(
  builtIn: readonly ApiKeyScopeOption[],
  contributed: readonly PremiumApiKeyScope[] | undefined,
  options: MergeContributedScopesOptions = {}
): ApiKeyScopeOption[] {
  const reject = (reason: string) => options.onReject?.(reason);
  const merged = [...builtIn];
  const byValue = new Map<string, ApiKeyScopeOption>(builtIn.map(row => [row.value, row]));
  for (const row of Array.isArray(contributed) ? contributed : []) {
    const value: unknown = row?.value;
    if (
      !isWellFormedApiKeyScope(value) ||
      typeof row.label !== 'string' ||
      typeof row.description !== 'string' ||
      !Array.isArray(row.endpoints) ||
      !row.endpoints.every((endpoint: unknown) => typeof endpoint === 'string') ||
      (row.requiredEntitlement !== undefined &&
        (typeof row.requiredEntitlement !== 'string' || row.requiredEntitlement === ''))
    ) {
      reject(`malformed scope row ${String(value)}`);
      continue;
    }
    const existing = byValue.get(value);
    if (existing) {
      const identical =
        existing.label === row.label &&
        existing.description === row.description &&
        sameEndpoints(existing.endpoints, row.endpoints) &&
        (isBuiltInApiKeyScope(existing.value) || existing.requiredEntitlement === row.requiredEntitlement);
      if (!identical) reject(`${value} conflicts with an existing scope row`);
      continue;
    }
    if (isBuiltInApiKeyScope(value)) {
      reject(`${value} is a built-in scope`);
      continue;
    }
    if (RESERVED_API_KEY_SCOPE_RESOURCES.has(value.slice(0, value.indexOf(':')))) {
      reject(`${value} uses a reserved resource`);
      continue;
    }
    const option: ApiKeyScopeOption = {
      value,
      label: row.label,
      description: row.description,
      endpoints: [...row.endpoints],
      ...(row.requiredEntitlement !== undefined ? { requiredEntitlement: row.requiredEntitlement } : {}),
    };
    byValue.set(value, option);
    merged.push(option);
  }
  return merged;
}

const REJECTED_SCOPE_CONTRIBUTIONS: string[] = [];

/** Every user-selectable scope: the built-in rows plus the contributed ones. */
export const USER_API_KEY_SCOPES: ApiKeyScopeOption[] = mergeContributedScopes(
  BUILT_IN_USER_API_KEY_SCOPES,
  premiumApiKeyScopes,
  { onReject: reason => REJECTED_SCOPE_CONTRIBUTIONS.push(reason) }
);
if (REJECTED_SCOPE_CONTRIBUTIONS.length > 0) {
  console.warn(`[api-keys] dropped contributed scope rows: ${REJECTED_SCOPE_CONTRIBUTIONS.join('; ')}`);
}

/** All user-selectable scope values, e.g. for a "Select All" action. */
export const USER_API_KEY_SCOPE_VALUES: ApiKeyScopeValue[] = USER_API_KEY_SCOPES.map(s => s.value);

/** Every scope value this deployment knows: the built-in enum plus the contributed rows. */
export const ALL_KNOWN_API_KEY_SCOPE_VALUES: ReadonlySet<string> = new Set<string>([
  ...Object.values(ApiKeyScope),
  ...USER_API_KEY_SCOPE_VALUES,
]);

/** The `isKnownScope` predicate the mint routes hand `createUserApiKey`. */
export const isKnownApiKeyScope = (value: string): boolean => ALL_KNOWN_API_KEY_SCOPE_VALUES.has(value);

/**
 * Scopes that are minted only through a dedicated flow (not the generic New-Key
 * modals), because they require extra binding the modals do not collect. Embed
 * keys need an agentId + origin allow-list (epic #41 Phase E).
 *
 * Derived from CONFINED_API_KEY_SCOPES (@bike4mind/common) rather than listed again
 * here, so a new confined scope only has to be declared once. A confined scope must
 * be a key's ONLY scope - `createUserApiKey` rejects a mint that mixes one with
 * anything else - and the generic modals are multi-select, so offering one there
 * would hand the user a selection the mint route refuses. Intersecting with the
 * catalog above keeps this to the confined scopes actually documented for users:
 * the rest (`cc-bridge:connect`, `overwatch-ingest:write`) live in
 * NON_MINTABLE_API_KEY_SCOPES and ADMIN_ONLY_API_KEY_SCOPES and never reach a modal
 * at all.
 */
export const DEDICATED_FLOW_SCOPES: ReadonlySet<ApiKeyScopeValue> = new Set(
  USER_API_KEY_SCOPES.filter(s => isBuiltInApiKeyScope(s.value) && CONFINED_API_KEY_SCOPES.includes(s.value)).map(
    s => s.value
  )
);

/** Scopes offered in the generic profile/admin New-Key modals (excludes dedicated-flow scopes). */
export const GENERIC_MODAL_API_KEY_SCOPES: ApiKeyScopeOption[] = USER_API_KEY_SCOPES.filter(
  s => !DEDICATED_FLOW_SCOPES.has(s.value)
);

/**
 * What a viewer may reach, for gating product scopes. Each flag mirrors the gate the scope's
 * routes enforce on the key's owner:
 * - `hasOptiAccess`: admin || developer || `optihashi:pro` (useOptiAccess; requestHasOptiAccess
 *   in the OptiHashi overlay).
 * - `hasOverwatchAccess`: admin || developer || `overwatch:pro` (requestHasOverwatchAccess in the
 *   Overwatch overlay, which also serves the marketing-reports routes).
 * - `hearthEnabled`: the `EnableHearth` admin setting (requireFeatureEnabled on pages/api/hearth/*).
 * - `bypass` / `entitlements`: admin || developer, else the viewer's entitlement keys; a contributed
 *   row's `requiredEntitlement` is checked against these.
 * Resolved by useApiKeyScopeAccess on the client and resolveApiKeyScopeAccess on the mint route.
 */
export interface ApiKeyScopeAccess {
  hasOptiAccess: boolean;
  hasOverwatchAccess: boolean;
  hearthEnabled: boolean;
  bypass: boolean;
  /** Empty under `bypass`, which skips the entitlement lookup. */
  entitlements: ReadonlySet<string>;
}

type ProductAccessFlag = 'hasOptiAccess' | 'hasOverwatchAccess' | 'hearthEnabled';

/**
 * Product scopes offered only when the matching ApiKeyScopeAccess flag holds; see isApiKeyScopeOffered.
 * `bob:read` and `bob:run` are deliberately absent: every signed-in account can use Bob, so no
 * flag holds for some viewers and not others (see the `bob` row in lib/entitlements/registry.ts).
 */
export const GATED_API_KEY_SCOPES: Readonly<Partial<Record<ApiKeyScope, ProductAccessFlag>>> = {
  [ApiKeyScope.OPTIHASHI_READ]: 'hasOptiAccess',
  [ApiKeyScope.OPTIHASHI_COMPUTE]: 'hasOptiAccess',
  [ApiKeyScope.OVERWATCH_READ]: 'hasOverwatchAccess',
  [ApiKeyScope.MARKETING_REPORTS_READ]: 'hasOverwatchAccess',
  [ApiKeyScope.MARKETING_REPORTS_WRITE]: 'hasOverwatchAccess',
  [ApiKeyScope.HEARTH_READ]: 'hearthEnabled',
  [ApiKeyScope.HEARTH_WRITE]: 'hearthEnabled',
};

const REQUIRED_ENTITLEMENT_BY_SCOPE: ReadonlyMap<string, string> = new Map(
  USER_API_KEY_SCOPES.flatMap(s => (s.requiredEntitlement ? [[s.value, s.requiredEntitlement] as const] : []))
);
const REQUIRED_ENTITLEMENTS: readonly string[] = [...new Set(REQUIRED_ENTITLEMENT_BY_SCOPE.values())].sort();

/**
 * Whether a viewer with `access` may be offered (and mint) `scope`. A built-in product scope follows
 * its GATED_API_KEY_SCOPES flag, a contributed row its `requiredEntitlement`; every other scope is ungated.
 */
export const isApiKeyScopeOffered = (scope: ApiKeyScopeValue, access: ApiKeyScopeAccess): boolean => {
  const gate = isBuiltInApiKeyScope(scope) ? GATED_API_KEY_SCOPES[scope] : undefined;
  if (gate) return access[gate];
  const required = REQUIRED_ENTITLEMENT_BY_SCOPE.get(scope);
  return !required || access.bypass || access.entitlements.has(required);
};

// One list per access combination, so callers get a stable reference (NewKeyModal re-seeds its
// selection when the identity changes).
const genericScopesCache = new Map<string, ApiKeyScopeOption[]>();

/** The generic scopes a viewer with `access` may see. Returns a stable reference per access combination. */
export const genericApiKeyScopesFor = (access: ApiKeyScopeAccess): ApiKeyScopeOption[] => {
  // Only the entitlements some contributed row requires can change the result, so the key holds
  // exactly those; keying on the whole set would grow the cache per distinct viewer.
  const heldRequired = REQUIRED_ENTITLEMENTS.filter(key => access.bypass || access.entitlements.has(key));
  const cacheKey = `${access.hasOptiAccess}:${access.hasOverwatchAccess}:${access.hearthEnabled}:${heldRequired.join(',')}`;
  let scopes = genericScopesCache.get(cacheKey);
  if (!scopes) {
    const offered = GENERIC_MODAL_API_KEY_SCOPES.filter(s => isApiKeyScopeOffered(s.value, access));
    scopes = offered.length === GENERIC_MODAL_API_KEY_SCOPES.length ? GENERIC_MODAL_API_KEY_SCOPES : offered;
    genericScopesCache.set(cacheKey, scopes);
  }
  return scopes;
};

/**
 * Scopes no mint route may ever issue: they are granted by a flow of their own
 * (`admin:*` is provisioned out of band, `cc-bridge:connect` by the bridge
 * pairing handshake) and must stay outside every allowlist. Listed explicitly so
 * the coverage test in apiKeyScopes.test.ts can tell "deliberately unmintable"
 * from "someone added an enum value and forgot to register it" - the failure mode
 * that once left the `datalake:*` scopes impossible to mint.
 *
 * Not derivable from CONFINED_API_KEY_SCOPES: confinement and mintability are
 * different questions. `embed:chat` and `overwatch-ingest:write` are confined yet
 * mintable (through their own flows), and `admin:*` is unmintable yet deliberately
 * not confined. The overlap that does matter - a confined scope must never be
 * offered in the generic modals - is asserted in apiKeyScopes.test.ts.
 */
export const NON_MINTABLE_API_KEY_SCOPES: ReadonlySet<ApiKeyScope> = new Set([
  ApiKeyScope.ADMIN,
  ApiKeyScope.CC_BRIDGE,
]);

/**
 * Scopes that are provisioned by admins only and must never appear in the user-facing
 * key creation UI. The ingest and automation scopes are excluded from USER_API_KEY_SCOPES by design.
 */
export const ADMIN_ONLY_API_KEY_SCOPES: ApiKeyScopeOption[] = [
  {
    value: ApiKeyScope.OVERWATCH_INGEST_WRITE,
    label: 'Overwatch: Ingest',
    description: 'Server-to-server event ingestion for Overwatch analytics',
    endpoints: ['POST /api/overwatch/v1/events'],
  },
  {
    value: ApiKeyScope.QA_INGEST,
    label: 'QA: Ingest',
    description: 'CI ingest of end-to-end test runs for the admin status page',
    endpoints: ['POST /api/qa/uploads', 'POST /api/qa/runs'],
  },
  {
    value: ApiKeyScope.RELEASE_NOTES_WRITE,
    label: 'Release Notes: Write',
    description:
      "Release-note automation: find a release note and set its video, and upload its What's New media. The key's user must be a platform admin",
    endpoints: [
      'GET /api/admin/release-notes',
      'PATCH /api/admin/release-notes/:id (video only)',
      'POST /api/files/createFabFile (purpose: modal-media only)',
    ],
  },
];
