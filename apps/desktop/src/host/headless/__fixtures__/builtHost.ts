import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { TokenVault } from '../../../main/auth/tokenVault';
import { createVaultFile } from '../../../main/auth/vaultFile';
import { createPermissionProtectedCipher } from '../../auth/permissionProtectedCipher';
import { ensurePrivateDirectory } from '../../auth/privateDirectory';

/**
 * The pieces an end-to-end test of the BUILT b4m-host program needs: a fake Bike4Mind API, the
 * bundle built against it, and a data directory that is already signed in. The seam is the HTTP
 * API, so the real chat service, runtime, protocol server, daemon and bridge all run unchanged.
 */

const DESKTOP = resolve(__dirname, '../../../..');
export const E2E_USER_ID = 'user-e2e';

function fakeAccessToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: userId }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

export type FakeApi = {
  server: Server;
  /** Requests the fake does not serve; a test expects this to stay empty. */
  unexpected: string[];
  /** Lets the first completion, held mid-stream, finish. */
  releaseTurn(): void;
  completions(): number;
  listen(): Promise<string>;
};

/** The Bike4Mind API, as far as one chat turn needs it. The first completion is held until released. */
export function startFakeApi(): FakeApi {
  let releaseTurn: () => void = () => undefined;
  const turnReleased = new Promise<void>(resolveTurn => {
    releaseTurn = resolveTurn;
  });
  let completions = 0;
  const unexpected: string[] = [];
  const sse = (body: unknown) => `data: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`;

  const json = (response: ServerResponse, body: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0];
    request.resume();
    if (path === '/api/identify') return json(response, { user: { id: E2E_USER_ID, email: 'rider@example.com' } });
    if (path === '/api/settings/fetch') return json(response, {});
    if (path === '/api/settings/serverConfig') return json(response, {});
    if (path === '/api/skills') return json(response, { data: [] });
    if (path === '/api/models' || path === '/api/v1/models' || path === '/api/v1/video-models') {
      return json(response, { data: [], models: [] });
    }
    if (path === '/api/ai/v1/completions' && request.method === 'POST') {
      const first = ++completions === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse({ type: 'content', text: 'Hello ' }));
      const finish = () =>
        response.end(sse({ type: 'content', text: 'there.', stopReason: 'end_turn' }) + sse('[DONE]'));
      if (first) void turnReleased.then(finish);
      else finish();
      return;
    }
    unexpected.push(`${request.method} ${path}`);
    response.writeHead(404).end();
  });
  return {
    server,
    unexpected,
    releaseTurn: () => releaseTurn(),
    completions: () => completions,
    listen: () =>
      new Promise<string>(resolveUrl =>
        server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
      ),
  };
}

/**
 * Builds vite.host.config.ts into `outDir` with `apiUrl` baked in, as a fork bakes its own server,
 * and returns the path of `b4m-host.cjs`. Put `outDir` where no node_modules sits above it, so
 * `electron` cannot resolve from the bundle.
 */
export async function buildHostBundle(outDir: string, apiUrl: string): Promise<string> {
  const baked = process.env.B4M_DEFAULT_API_URL;
  process.env.B4M_DEFAULT_API_URL = apiUrl;
  try {
    const { build } = await import('vite');
    await build({
      configFile: join(DESKTOP, 'vite.host.config.ts'),
      root: DESKTOP,
      mode: 'production',
      logLevel: 'error',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (baked === undefined) delete process.env.B4M_DEFAULT_API_URL;
    else process.env.B4M_DEFAULT_API_URL = baked;
  }
  return join(outDir, 'b4m-host.cjs');
}

/** Signed in already, as a user who ran sign-in once before: tokens far from expiry. */
export async function seedSignedInVault(dataDirectory: string, apiUrl: string): Promise<void> {
  await ensurePrivateDirectory(dataDirectory);
  const vault = new TokenVault(
    createPermissionProtectedCipher(),
    createVaultFile(join(dataDirectory, 'auth-vault.json')),
    {
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }
  );
  await vault.setEnvironment({ preset: 'custom', customUrl: apiUrl });
  await vault.setTokens(apiUrl, {
    accessToken: fakeAccessToken(E2E_USER_ID),
    refreshToken: 'refresh-e2e',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    userId: E2E_USER_ID,
  });
}
