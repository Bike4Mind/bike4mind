import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import type { BillingPayer } from '@shared/account';
import { MediaApiClient, type MediaRun } from './MediaApiClient';

type Submit = (client: MediaApiClient, idempotencyKey: string) => Promise<unknown>;

let keyCounter = 0;
const freshKey = () => `key-${++keyCounter}`;

function harness(runPayer?: BillingPayer) {
  let payer: BillingPayer = { organization_id: null };
  const post = vi.fn().mockResolvedValue({});
  const axiosPost = vi.fn().mockResolvedValue({ data: new ArrayBuffer(0), headers: {} });
  const api = { post, getAxiosInstance: () => ({ post: axiosPost }) } as unknown as AuthenticatedApiClient;
  const run: MediaRun | undefined = runPayer && {
    current: () => ({ runId: 'run-1', role: 'root' }),
    budgeted: false,
    onRejected: async () => undefined,
    payer: runPayer,
  };
  const client = new MediaApiClient(api, run, () => payer);
  const submitted = async (call: Submit, idempotencyKey = freshKey()) => {
    post.mockClear();
    axiosPost.mockClear();
    await call(client, idempotencyKey).catch(() => undefined);
    return (post.mock.calls[0] ?? axiosPost.mock.calls[0]) as [string, Record<string, unknown>];
  };
  return {
    submitted,
    pay: (next: BillingPayer) => {
      payer = next;
    },
  };
}

const CASES: [string, string, Submit][] = [
  ['createImageJob', '/api/v1/image-jobs', (c, key) => c.createImageJob({ prompt: 'p', model: 'm' } as never, key)],
  [
    'createImageJobGroup',
    '/api/v1/image-jobs',
    (c, key) => c.createImageJobGroup({ model: 'm', mode: 'generate', prompt: 'p', count: 2 } as never, key),
  ],
  [
    'createVideoGeneration',
    '/api/v1/video-generations',
    (c, key) => c.createVideoGeneration({ prompt: 'p', model: 'm' } as never, key),
  ],
  [
    'createMusicGeneration',
    '/api/v1/music-generations',
    (c, key) => c.createMusicGeneration({ prompt: 'p', model: 'm' } as never, key),
  ],
  ['synthesizeSpeech', '/api/ai/tts', c => c.synthesizeSpeech({ text: 'hi' } as never)],
  ['generateSoundEffect', '/api/ai/sound-effects', c => c.generateSoundEffect({ text: 'boom' } as never)],
];

describe('MediaApiClient payer', () => {
  it.each(CASES)('%s states the payer on %s, read at submit time', async (_name, path, call) => {
    const { submitted, pay } = harness();

    const personal = await submitted(call);
    expect(personal[0]).toBe(path);
    expect(personal[1]).toHaveProperty('organization_id', null);

    pay({ organization_id: 'org-1' });
    const organization = await submitted(call);
    expect(organization[0]).toBe(path);
    expect(organization[1]).toHaveProperty('organization_id', 'org-1');
  });

  it.each(CASES.filter(([, path]) => path.startsWith('/api/v1/')))(
    '%s keeps the first payer for a retried Idempotency-Key on %s',
    async (_name, _path, call) => {
      const { submitted, pay } = harness();
      const key = freshKey();

      await submitted(call, key);
      pay({ organization_id: 'org-1' });
      const retry = await submitted(call, key);

      expect(retry[1]).toHaveProperty('organization_id', null);
    }
  );

  it.each(CASES)(
    "%s bills an organization run's payer on %s after the selection switches",
    async (_name, _path, call) => {
      const { submitted, pay } = harness({ organization_id: 'org-1' });
      pay({ organization_id: null });

      const sent = await submitted(call);
      expect(sent[1]).toHaveProperty('organization_id', 'org-1');
      expect(sent[1]).toHaveProperty('run.runId', 'run-1');
    }
  );

  it.each(CASES)(
    '%s states null for a Personal run on %s after an organization is selected',
    async (_name, _path, call) => {
      const { submitted, pay } = harness({ organization_id: null });
      pay({ organization_id: 'org-1' });

      expect((await submitted(call))[1]).toHaveProperty('organization_id', null);
    }
  );
});
