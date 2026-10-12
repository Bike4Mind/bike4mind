import { api } from '@client/app/contexts/ApiContext';

export type DriveAccessTokenResult =
  | { kind: 'token'; accessToken: string }
  /** Drive was never linked, or the stored grant no longer refreshes: send the user to consent. */
  | { kind: 'consent'; authUrl: string }
  | { kind: 'unavailable' };

function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

/**
 * Check the caller's Google Drive grant via GET /api/google-drive/token, the OAuth prelude shared by
 * the folder picker and the lake Re-sync. A first-time user (the route 400s "Google Drive not
 * connected") gets an authorize URL from POST /connect, the same flow the profile page starts. Any
 * other request failure is thrown for the caller to report.
 */
export async function fetchDriveAccessToken(): Promise<DriveAccessTokenResult> {
  let token: { accessToken?: string; authUrl?: string };
  try {
    const { data } = await api.get<{ accessToken?: string; authUrl?: string }>('/api/google-drive/token');
    token = data;
  } catch (e) {
    if (httpStatus(e) !== 400) throw e;
    const { data } = await api.post<{ authUrl: string }>('/api/google-drive/connect');
    return { kind: 'consent', authUrl: data.authUrl };
  }
  if (token.authUrl) return { kind: 'consent', authUrl: token.authUrl };
  if (token.accessToken) return { kind: 'token', accessToken: token.accessToken };
  return { kind: 'unavailable' };
}
