import { describe, expect, it } from 'vitest';
import { OllamaRuntime } from '../ollama';
import { probeServer } from './probe';
import { createSshFetch, SSH_OLLAMA_URL, SSH_PROBE_TIMEOUT_MS, SshRefusedError } from './ssh';

// Opt-in checks through the real ssh client, skipped unless LOCAL_MODELS_LIVE_SSH is set; the package README has the command.
const DESTINATION = process.env.LOCAL_MODELS_LIVE_SSH;
const COMMAND = process.env.LOCAL_MODELS_LIVE_SSH_COMMAND || undefined;
const REMOTE_COMMAND = process.env.LOCAL_MODELS_LIVE_SSH_REMOTE_COMMAND;
const UNKNOWN_KEY = process.env.LOCAL_MODELS_LIVE_SSH_UNKNOWN_KEY;

const now = () => performance.now();

describe.skipIf(!DESTINATION)('SSH model server (live)', () => {
  const fetchFor = (destination: string, home?: string) =>
    createSshFetch({ destination, label: destination }, { command: COMMAND, ...(home ? { home } : {}) });

  it('probes, lists and chats with Ollama over a stdio forward', async () => {
    const fetch = fetchFor(DESTINATION as string);
    const outcome = await probeServer(fetch, SSH_OLLAMA_URL, 'live', now, 'ollama', SSH_PROBE_TIMEOUT_MS);
    expect(outcome.kind).toBe('ollama');
    const runtime = new OllamaRuntime({ baseUrl: SSH_OLLAMA_URL, id: 'srv-live', fetch });
    const [model] = await runtime.list();
    expect(model).toBeDefined();
    const response = await fetch(`${SSH_OLLAMA_URL}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: model.name,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with the word ok.' }],
        options: { num_predict: 8 },
      }),
    });
    const reply = (await response.json()) as { message?: { content?: string } };
    expect(typeof reply.message?.content).toBe('string');
  }, 120_000);

  it('connects without connection sharing when the home path is too long for its socket', async () => {
    const fetch = fetchFor(DESTINATION as string, `/home/${'x'.repeat(120)}`);
    const outcome = await probeServer(fetch, SSH_OLLAMA_URL, 'live', now, 'ollama', SSH_PROBE_TIMEOUT_MS);
    expect(outcome.kind).toBe('ollama');
  }, 60_000);

  it.skipIf(!REMOTE_COMMAND)(
    "works when the user's ssh config sets RemoteCommand",
    async () => {
      const outcome = await probeServer(
        fetchFor(REMOTE_COMMAND as string),
        SSH_OLLAMA_URL,
        'live',
        now,
        'ollama',
        SSH_PROBE_TIMEOUT_MS
      );
      expect(outcome.kind).toBe('ollama');
    },
    60_000
  );

  it.skipIf(!UNKNOWN_KEY)(
    'fails closed on an unknown host key with the terminal hint',
    async () => {
      const fetch = fetchFor(UNKNOWN_KEY as string);
      const failure = await fetch(`${SSH_OLLAMA_URL}/api/version`).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(SshRefusedError);
      expect((failure as Error).message).toBe(
        `Connect once from a terminal with \`ssh ${UNKNOWN_KEY}\` to trust this server's host key.`
      );
    },
    60_000
  );
});
