import { isAxiosError } from 'axios';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatArtifact, ChatArtifactSave } from '@shared/chat';

const ARTIFACTS_ENDPOINT = '/api/artifacts';

/** The server refuses a body over this; `content` is the only field that can reach it. */
const MAX_CONTENT_CHARS = 2_000_000;

/**
 * Writes a desktop reply's artifacts to `POST /api/artifacts`, which is what makes them
 * reachable from the web app.
 *
 * Neither existing persistence path covers this client (see the header of the server's
 * `persistAgentArtifacts.ts`): web chat mode parses the finished quest in the BROWSER off its
 * WebSocket action, and agent mode persists server-side inside `persistRunAsQuest`. The desktop
 * uses the stateless completions endpoint - no quest, no WebSocket, nothing server-side that
 * sees the reply - so this is the only place the row can be written.
 *
 * Auth needs nothing new: the route is a `baseApi()` handler reading `req.user?.id`, and its
 * default `auth: true` accepts this client's device-flow JWT, the same one already carrying
 * `/api/models`, `/api/settings/serverConfig` and `/api/ai/generate-image`.
 */
export class ArtifactPublisher {
  constructor(
    private readonly getApiClient: () => AuthenticatedApiClient | null,
    private readonly logger: { debug(message: string): void }
  ) {}

  /**
   * Save each artifact, reporting an outcome per artifact rather than a single verdict: a
   * turn that emitted three artifacts and could store two of them has to say which.
   *
   * Never throws. A reply that has already been shown to the user is not retracted because the
   * server would not take a copy of it - the card says the copy failed and the local artifact
   * stays exactly as it is.
   */
  async publish(artifacts: readonly ChatArtifact[], desktopSessionId: string): Promise<ChatArtifact[]> {
    const api = this.getApiClient();
    if (!api) {
      return artifacts.map(artifact => withSave(artifact, { status: 'failed', reason: 'Not signed in.' }));
    }

    return Promise.all(artifacts.map(artifact => this.publishOne(api, artifact, desktopSessionId)));
  }

  private async publishOne(
    api: AuthenticatedApiClient,
    artifact: ChatArtifact,
    desktopSessionId: string
  ): Promise<ChatArtifact> {
    if (artifact.content.length > MAX_CONTENT_CHARS) {
      return withSave(artifact, { status: 'failed', reason: 'Too large to store on the server.' });
    }

    try {
      await api.getAxiosInstance().post(ARTIFACTS_ENDPOINT, this.buildPayload(artifact, desktopSessionId));
      return withSave(artifact, { status: 'saved' });
    } catch (err) {
      const save = toSaveFailure(err);
      this.logger.debug(`ARTIFACTS: ${artifact.id} not saved: ${save.reason}`);
      return withSave(artifact, save);
    }
  }

  /**
   * Matches what the web client posts (`app/utils/artifactPersistence.ts`) in the fields the
   * server keys on - `metadata.aiGenerated` is what subjects the row to the user's artifact
   * opt-out in `isAiAuthoredCreate`, and claiming otherwise would route around a preference the
   * user set.
   *
   * `sessionId` is deliberately ABSENT. The field takes a server Session id, and the route
   * hands whatever it is given to `assertArtifactSourceRefsAccessible`, which 403s the whole
   * create unless the caller has update access to that session. A desktop session id names a
   * JSON file on this machine and no server row at all, so sending it would fail every save; it
   * goes in `metadata` instead, where it is a traceable local reference and not a claim about a
   * session on the server.
   */
  private buildPayload(artifact: ChatArtifact, desktopSessionId: string): Record<string, unknown> {
    return {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      description: `Desktop-generated ${artifact.type} artifact`,
      content: artifact.content,
      visibility: 'private',
      tags: ['ai-generated', 'desktop'],
      metadata: {
        ...(artifact.language ? { language: artifact.language } : {}),
        ...(artifact.identifier ? { identifier: artifact.identifier } : {}),
        aiGenerated: true,
        createdFrom: 'desktop',
        desktopSessionId,
      },
    };
  }
}

function withSave(artifact: ChatArtifact, save: ChatArtifactSave): ChatArtifact {
  return { ...artifact, save };
}

/**
 * 403 is the artifact opt-out, not a fault: the route answers it when `EnableArtifacts` is off
 * for this user, and telling them their artifact "failed to save" would send them looking for a
 * problem instead of at the setting they turned off.
 */
function toSaveFailure(err: unknown): ChatArtifactSave {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 403) {
      return { status: 'disabled', reason: 'Artifacts are turned off for your account.' };
    }
    if (status === 401) {
      return { status: 'failed', reason: 'Your session has expired.' };
    }
    if (status) return { status: 'failed', reason: `The server answered ${status}.` };
    return { status: 'failed', reason: 'The server could not be reached.' };
  }
  return { status: 'failed', reason: err instanceof Error ? err.message : 'Unknown error.' };
}
