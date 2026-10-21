import { isAxiosError } from 'axios';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatArtifactContent, ChatArtifactLibrary, ChatArtifactSummary } from '@shared/chat';

const ARTIFACTS_ENDPOINT = '/api/artifacts';

/**
 * The tag ArtifactPublisher stamps on every row it writes, and the only handle the list route
 * offers for "made by this app": there is no `createdFrom` filter, but `tags` is matched with
 * `$in` server-side (artifactService/list.ts), so this narrows the query at the database rather
 * than fetching the account's whole collection and filtering here.
 *
 * MUST STAY IN STEP with the `tags` in ArtifactPublisher.buildPayload.
 */
const DESKTOP_TAG = 'desktop';

/** The route caps `limit` at 100 and rejects more, so this is the ceiling, not a preference. */
const PAGE_SIZE = 100;

/**
 * Reads the artifacts this account has on the server, for the library panel.
 *
 * Deliberately the SERVER's copy rather than a walk of the local session files. A desktop
 * session is local, but an artifact is not: it is posted to `/api/artifacts` as it is made, so
 * the server holds the union of every machine this account uses - and it is also the only
 * version that reflects an edit made in the web app. A local scan would show a stale body and
 * miss anything made elsewhere.
 *
 * The cost is that this needs the network and a signed-in account, so both failures are values
 * the panel can render rather than exceptions (see ChatArtifactLibrary.error).
 */
export class ArtifactLibrary {
  constructor(
    private readonly getApiClient: () => AuthenticatedApiClient | null,
    private readonly logger: { debug(message: string): void }
  ) {}

  async list(): Promise<ChatArtifactLibrary> {
    const api = this.getApiClient();
    if (!api) return { artifacts: [], total: 0, error: 'Sign in to see your artifacts.' };

    try {
      const response = await api.getAxiosInstance().get(ARTIFACTS_ENDPOINT, {
        params: {
          tags: [DESKTOP_TAG],
          limit: PAGE_SIZE,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        },
      });
      return toLibrary(response.data);
    } catch (err) {
      const error = describe(err);
      this.logger.debug(`ARTIFACTS: library list failed: ${error}`);
      return { artifacts: [], total: 0, error };
    }
  }

  async read(id: string): Promise<ChatArtifactContent> {
    const api = this.getApiClient();
    if (!api) return { error: 'Sign in to see your artifacts.' };

    try {
      const response = await api
        .getAxiosInstance()
        .get(`${ARTIFACTS_ENDPOINT}/${encodeURIComponent(id)}`, { params: { includeContent: true } });
      const artifact = toContent(response.data);
      return artifact ? { artifact } : { error: 'The server returned no content for this artifact.' };
    } catch (err) {
      const error = describe(err);
      this.logger.debug(`ARTIFACTS: reading ${id} failed: ${error}`);
      return { error };
    }
  }
}

/**
 * The list response is server-shaped and read defensively: this client does not own that schema,
 * and a row missing a field it did not expect must drop that row rather than the whole panel.
 */
function toLibrary(data: unknown): ChatArtifactLibrary {
  const body = asRecord(data);
  const rows = Array.isArray(body?.artifacts) ? body.artifacts : [];
  const artifacts = rows.map(toSummary).filter((row): row is ChatArtifactSummary => row !== null);
  const total = asRecord(body?.pagination)?.total;
  return { artifacts, total: typeof total === 'number' ? total : artifacts.length };
}

function toSummary(row: unknown): ChatArtifactSummary | null {
  const artifact = asRecord(row);
  const id = artifact?.id;
  const type = artifact?.type;
  if (typeof id !== 'string' || typeof type !== 'string') return null;

  return {
    id,
    type,
    title: typeof artifact?.title === 'string' ? artifact.title : 'Untitled artifact',
    // Serialized over JSON, so a Date has already become a string by the time it lands here.
    createdAt: typeof artifact?.createdAt === 'string' ? artifact.createdAt : '',
    ...(typeof artifact?.description === 'string' ? { description: artifact.description } : {}),
  };
}

/** `GET /api/artifacts/{id}?includeContent=true` answers `{ artifact, content }`, the body on `content.content`. */
function toContent(data: unknown): ChatArtifactContent['artifact'] {
  const body = asRecord(data);
  const summary = toSummary(body?.artifact);
  const content = asRecord(body?.content)?.content;
  if (!summary || typeof content !== 'string') return undefined;
  return { id: summary.id, type: summary.type, title: summary.title, content };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function describe(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401) return 'Your session has expired. Sign in again.';
    if (status === 404) return 'That artifact is no longer on the server.';
    if (status) return `The server answered ${status}.`;
    return 'The server could not be reached.';
  }
  return err instanceof Error ? err.message : 'Unknown error.';
}
