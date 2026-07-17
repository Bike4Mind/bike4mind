import { type APIRequestContext } from '@playwright/test';
import { Resource } from 'sst';
import crypto from 'crypto';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown> & { id?: string; _id?: string };
}

export async function apiCreateSession(
  request: APIRequestContext,
  token: string,
  name = 'E2E Test Session'
): Promise<string> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/sessions/create`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  });

  if (!response.ok()) {
    throw new Error(`Create session failed: ${response.status()}`);
  }

  const body = await response.json();
  return body.id || body._id;
}

export async function apiDeleteSession(request: APIRequestContext, token: string, sessionId: string): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  await request.delete(`${baseURL}/api/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function apiRenameSession(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  name: string
): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.put(`${baseURL}/api/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  });

  if (!response.ok()) {
    throw new Error(`Rename session failed: ${response.status()}`);
  }
}

export async function apiDeleteProject(request: APIRequestContext, token: string, projectId: string): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  await request.delete(`${baseURL}/api/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function apiListAgents(
  request: APIRequestContext,
  token: string
): Promise<Array<{ _id: string; name: string }>> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.get(`${baseURL}/api/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok()) {
    return [];
  }

  const body = await response.json();
  return body.data || [];
}

export async function apiDeleteAgent(request: APIRequestContext, token: string, agentId: string): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  await request.delete(`${baseURL}/api/agents/${agentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function apiCreateTestUser(
  request: APIRequestContext,
  params: {
    username: string;
    email: string;
    name: string;
    password: string;
    isAdmin?: boolean;
    tags?: string[];
    emailVerified?: boolean;
    // Pass false to mint an UNCONSENTED user (for a spec that exercises the consent gate /
    // /accept-policies interstitial). Suppresses both the server-side stamp and the auto-accept
    // fallback below. Defaults to consented so ordinary setup isn't 403'd by the gate.
    acceptedPolicies?: boolean;
  }
): Promise<LoginResponse> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;
  if (!secret) {
    throw new Error('E2E_CLEANUP_SECRET must be set in .env.e2e');
  }
  const response = await request.post(`${baseURL}/api/test/create-user`, {
    data: params,
    headers: { 'x-e2e-cleanup-secret': secret },
  });

  if (!response.ok()) {
    throw new Error(`Create test user failed: ${response.status()} ${response.statusText()}`);
  }

  const result: LoginResponse = await response.json();

  // AUP/ToS consent gate: an unaccepted account gets 403'd on every authenticated endpoint (not
  // just the UI), so the next setup call (e.g. apiUpdateAdminSetting) would fail. Newer envs stamp
  // acceptance in /api/test/create-user; older envs don't, so stamp it here via the gate-exempt
  // endpoint (idempotent - skipped if already stamped). Honors acceptedPolicies: false as an opt-out.
  if (params.acceptedPolicies !== false && !result.user.aupAcceptedVersion) {
    await apiAcceptPolicies(request, result.accessToken);
  }

  return result;
}

/**
 * Records the authenticated user's AUP/ToS acceptance + 18+ attestation. On the consent-gate
 * allowlist, so an unconsented account can call it while blocked everywhere else - clears the
 * gate for later API calls and lets the seeded currentUser pass the router's consent guard too.
 */
export async function apiAcceptPolicies(request: APIRequestContext, token: string): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/user/accept-policies`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { ageAttestation: true },
  });
  if (!response.ok()) {
    throw new Error(`Accept policies failed: ${response.status()} ${response.statusText()}`);
  }
}

/**
 * Fetch the plaintext OTC that /api/otc/send just emailed to a test account, so a spec
 * can complete the passwordless login/registration flow without a mailbox. Non-prod only,
 * gated by the E2E secret + a -e2e@test.com email restriction (see /api/test/otc-code).
 */
export async function apiGetOtcCode(request: APIRequestContext, email: string): Promise<string> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;
  if (!secret) {
    throw new Error('E2E_CLEANUP_SECRET must be set in .env.e2e');
  }
  const response = await request.get(`${baseURL}/api/test/otc-code?email=${encodeURIComponent(email)}`, {
    headers: { 'x-e2e-cleanup-secret': secret },
  });
  if (!response.ok()) {
    throw new Error(`Get OTC code failed: ${response.status()} ${response.statusText()}`);
  }
  const body = await response.json();
  return body.code;
}

export async function apiCreateFile(
  request: APIRequestContext,
  token: string,
  params: {
    fileName: string;
    content: string;
    mimeType?: string;
    /** Tag the file (e.g. a data lake's datalakeTag) so it surfaces as a lake article. */
    tags?: { name: string; strength?: number }[];
    /** Explicit content hash — set to sha256Hex(content) to make the file a dedup match. */
    contentHash?: string;
  }
): Promise<string> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/files/createFabFile`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      fileName: params.fileName,
      mimeType: params.mimeType || 'text/plain',
      fileSize: Buffer.byteLength(params.content, 'utf-8'),
      type: 'FILE',
      content: params.content,
      ...(params.tags ? { tags: params.tags.map(t => ({ name: t.name, strength: t.strength ?? 1 })) } : {}),
      ...(params.contentHash ? { contentHash: params.contentHash } : {}),
    },
  });

  if (!response.ok()) {
    throw new Error(`Create file failed: ${response.status()} ${response.statusText()}`);
  }

  const body = await response.json();
  return body.id || body._id;
}

/** SHA-256 hex of a string — matches the client-side hash the dedup check computes over file bytes. */
export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Seed a file directly INTO a lake by tagging it with the lake's datalakeTag, so it shows up as
 * an article without driving the (heavy) upload wizard. Pass `contentHash` to also make it a
 * dedup match for a wizard upload of the same content.
 */
export async function apiSeedLakeArticle(
  request: APIRequestContext,
  token: string,
  lake: { datalakeTag: string },
  params: { fileName: string; content: string; contentHash?: string }
): Promise<string> {
  return apiCreateFile(request, token, {
    fileName: params.fileName,
    content: params.content,
    contentHash: params.contentHash,
    tags: [{ name: lake.datalakeTag, strength: 1 }],
  });
}

export async function apiUpdateAdminSetting(
  request: APIRequestContext,
  adminToken: string,
  key: string,
  value: unknown
): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.put(`${baseURL}/api/settings/update`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { key, value },
  });

  if (!response.ok()) {
    throw new Error(`Update admin setting failed: ${response.status()} ${response.statusText()}`);
  }
}

export async function apiCreateInviteCode(
  request: APIRequestContext,
  adminToken: string
): Promise<{ id: string; code: string }> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/reg-invites/create`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { multiple: 1 },
  });

  if (!response.ok()) {
    throw new Error(`Create invite code failed: ${response.status()} ${response.statusText()}`);
  }

  const invites = await response.json();
  const invite = invites[0];
  return { id: invite._id, code: invite.code };
}

export async function apiDeleteInviteCode(
  request: APIRequestContext,
  adminToken: string,
  inviteId: string
): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/reg-invites/delete`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { ids: [inviteId] },
  });

  if (!response.ok()) {
    throw new Error(`Delete invite code failed: ${response.status()} ${response.statusText()}`);
  }
}

export async function apiUpdateUserPreferences(
  request: APIRequestContext,
  token: string,
  userId: string,
  preferences: Record<string, unknown>
): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.put(`${baseURL}/api/users/${userId}/update`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { preferences },
  });

  if (!response.ok()) {
    throw new Error(`Update user preferences failed: ${response.status()} ${response.statusText()}`);
  }
}

export async function apiUpdateUser(
  request: APIRequestContext,
  token: string,
  userId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.put(`${baseURL}/api/users/${userId}/update`, {
    headers: { Authorization: `Bearer ${token}` },
    data: fields,
  });

  if (!response.ok()) {
    throw new Error(`Update user failed: ${response.status()} ${response.statusText()}`);
  }
}

// ── Data Lakes ────────────────────────────────────────────────────────────────
// Helpers for the data-lake E2E suite. The feature is gated by the EnableDataLakes
// admin setting (default off) — enable it once in setup with an admin token, then
// pre-seed / tear down lakes via these instead of driving the (heavy) upload wizard.

export interface DataLake {
  id: string;
  slug: string;
  name: string;
  description?: string;
  fileTagPrefix: string;
  requiredUserTag?: string;
  requiredEntitlement?: string;
  organizationId?: string;
  datalakeTag: string;
  fileCount?: number;
  createdAt: string;
}

/** Turn a display name into a schema-valid slug (lowercase alphanumeric + hyphens, 2–60 chars). */
export function toDataLakeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  // Schema requires min length 2 and no leading/trailing hyphen.
  return slug.length >= 2 ? slug : `dl-${slug}`;
}

/** Enable the admin-gated EnableDataLakes feature flag (idempotent). Requires an admin token. */
export async function apiEnableDataLakes(request: APIRequestContext, adminToken: string): Promise<void> {
  await apiUpdateAdminSetting(request, adminToken, 'EnableDataLakes', true);
}

export async function apiCreateDataLake(
  request: APIRequestContext,
  token: string,
  params: {
    name: string;
    /** Defaults to a slug derived from `name`. Must be lowercase alphanumeric + hyphens. */
    slug?: string;
    /** Must end with ":" (e.g. "e2e:"). Defaults to a prefix derived from the slug. */
    fileTagPrefix?: string;
    description?: string;
    requiredUserTag?: string;
    requiredEntitlement?: string;
    organizationId?: string;
  }
): Promise<DataLake> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const slug = params.slug ?? toDataLakeSlug(params.name);
  const fileTagPrefix = params.fileTagPrefix ?? `${slug.replace(/-/g, '').slice(0, 20) || 'e2e'}:`;
  const response = await request.post(`${baseURL}/api/data-lakes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: params.name,
      slug,
      fileTagPrefix,
      ...(params.description ? { description: params.description } : {}),
      ...(params.requiredUserTag ? { requiredUserTag: params.requiredUserTag } : {}),
      ...(params.requiredEntitlement ? { requiredEntitlement: params.requiredEntitlement } : {}),
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    },
  });

  if (!response.ok()) {
    throw new Error(`Create data lake failed: ${response.status()} ${response.statusText()}`);
  }

  const body = await response.json();
  return { ...body, id: body.id || body._id } as DataLake;
}

/** List active data lakes accessible to the caller. */
export async function apiListDataLakes(request: APIRequestContext, token: string): Promise<DataLake[]> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.get(`${baseURL}/api/data-lakes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    throw new Error(`List data lakes failed: ${response.status()} ${response.statusText()}`);
  }
  const body = await response.json();
  return body.data as DataLake[];
}

/** Raw status of the list endpoint for a token — used to assert the gate (403 when the feature is off). */
export async function apiListDataLakesStatus(request: APIRequestContext, token: string): Promise<number> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.get(`${baseURL}/api/data-lakes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.status();
}

/** Raw GET of a lake's articles — asserts the SERVER-side access boundary (403/404) for a given token. */
export async function apiGetDataLakeArticlesStatus(
  request: APIRequestContext,
  token: string,
  dataLakeId: string
): Promise<number> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.get(`${baseURL}/api/data-lakes/${dataLakeId}/articles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.status();
}

export type DataLakeLifecycleAction = 'archive' | 'unarchive' | 'restore' | 'delete' | 'cleanup';

/** Drive a lake lifecycle transition. Returns the response status (so callers can assert 403 for non-owners). */
export async function apiLakeLifecycle(
  request: APIRequestContext,
  token: string,
  dataLakeId: string,
  action: DataLakeLifecycleAction
): Promise<number> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/data-lakes/${dataLakeId}/lifecycle`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { action },
  });
  return response.status();
}

export async function apiSetDataLakeVisibility(
  request: APIRequestContext,
  token: string,
  dataLakeId: string,
  visibility: 'private' | 'organization',
  organizationId?: string
): Promise<number> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/data-lakes/${dataLakeId}/visibility`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { visibility, ...(organizationId ? { organizationId } : {}) },
  });
  return response.status();
}

export async function apiUpdateDataLake(
  request: APIRequestContext,
  token: string,
  dataLakeId: string,
  fields: { name?: string; description?: string; requiredUserTag?: string; requiredEntitlement?: string }
): Promise<number> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.put(`${baseURL}/api/data-lakes/${dataLakeId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: fields,
  });
  return response.status();
}

/**
 * Best-effort teardown for a created lake. Purges via the lifecycle: soft-delete (phase 1)
 * then irreversible cleanup (phase 2). The DELETE route only *archives* (reversible), which
 * would leave test lakes accumulating on the shared stage, so we drive the purge directly.
 * Never throws so an afterAll cleanup can't fail a green run.
 *
 * Cleanup is enqueued to a background queue (returns 202), so poll until the lake record is
 * actually gone before returning - otherwise teardown races the consumer and leaves lakes on
 * the shared stage. Bounded so a slow/stuck consumer can't hang the suite.
 */
export async function apiDeleteDataLake(request: APIRequestContext, token: string, dataLakeId: string): Promise<void> {
  await apiLakeLifecycle(request, token, dataLakeId, 'delete').catch(() => 0);
  await apiLakeLifecycle(request, token, dataLakeId, 'cleanup').catch(() => 0);
  for (let i = 0; i < 20; i++) {
    // The lake record is deleted last, so a not-found on its articles means the sweep finished.
    const status = await apiGetDataLakeArticlesStatus(request, token, dataLakeId).catch(() => 0);
    if (status === 404) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

interface SkillSeed {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
}

/** Create a user-scoped skill via the API - for fast pre-seed of list/search/detail specs. */
export async function apiCreateSkill(
  request: APIRequestContext,
  token: string,
  params: SkillSeed
): Promise<{ id: string; name: string }> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/skills`, {
    headers: { Authorization: `Bearer ${token}` },
    data: params,
  });

  if (!response.ok()) {
    throw new Error(`Create skill failed: ${response.status()} ${response.statusText()}`);
  }

  const body = await response.json();
  return { id: (body.id || body._id) as string, name: body.name };
}

/** List the caller's accessible skills (owned + shared + global-read). */
export async function apiListSkills(
  request: APIRequestContext,
  token: string
): Promise<Array<{ id: string; name: string }>> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.get(`${baseURL}/api/skills?limit=100&page=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok()) {
    return [];
  }

  const body = await response.json();
  return (body.data || []).map((s: Record<string, unknown>) => ({ id: (s.id || s._id) as string, name: s.name }));
}

export async function apiDeleteSkill(request: APIRequestContext, token: string, skillId: string): Promise<void> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  await request.delete(`${baseURL}/api/skills/${skillId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Delete every skill the caller owns - idempotent teardown so a shared preview stays clean. */
export async function apiDeleteAllSkills(request: APIRequestContext, token: string): Promise<void> {
  const skills = await apiListSkills(request, token);
  for (const skill of skills) {
    await apiDeleteSkill(request, token, skill.id);
  }
}
