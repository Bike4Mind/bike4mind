import { PassThrough } from 'node:stream';
import type { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingPayer } from '@shared/account';
import { setBillingPayerSource } from '../account/billingPayer';
import { streamCompletion } from './completions';

const REQUEST = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

async function sentBody(billingPayer?: () => BillingPayer): Promise<Record<string, unknown>> {
  const stream = new PassThrough();
  const post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
  const done = streamCompletion({ post } as unknown as AxiosInstance, '/c', REQUEST, () => undefined, undefined, {
    billingPayer,
  });
  stream.end();
  await done;
  return post.mock.calls[0][1] as Record<string, unknown>;
}

afterEach(() => setBillingPayerSource(() => ({ organization_id: null })));

describe('streamCompletion payer', () => {
  it('sends organization_id when an organization pays', async () => {
    expect(await sentBody(() => ({ organization_id: 'org-1' }))).toHaveProperty('organization_id', 'org-1');
  });

  it('omits organization_id for Personal, which the route already bills', async () => {
    expect(await sentBody(() => ({ organization_id: null }))).not.toHaveProperty('organization_id');
  });

  it("reads the account menu's payer on each request by default", async () => {
    let payer: BillingPayer = { organization_id: 'org-1' };
    setBillingPayerSource(() => payer);
    expect(await sentBody()).toHaveProperty('organization_id', 'org-1');
    payer = { organization_id: null };
    expect(await sentBody()).not.toHaveProperty('organization_id');
  });
});
