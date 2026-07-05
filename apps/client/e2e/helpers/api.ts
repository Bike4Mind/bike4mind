import { type APIRequestContext } from '@playwright/test';
import { Resource } from 'sst';

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
  params: { fileName: string; content: string; mimeType?: string }
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
    },
  });

  if (!response.ok()) {
    throw new Error(`Create file failed: ${response.status()} ${response.statusText()}`);
  }

  const body = await response.json();
  return body.id || body._id;
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
