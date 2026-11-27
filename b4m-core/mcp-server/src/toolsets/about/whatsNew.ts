import { z } from 'zod';
import { envelope, fail, ok, paginationInput, UNTRUSTED_NOTE } from '../../results';
import { defineTool } from '../../tool';

const noteSchema = z.object({
  id: z.string(),
  release_tag: z.string(),
  published_at: z.string(),
  untrusted_title: z.string(),
  untrusted_body: z.string(),
});

interface UpstreamNote {
  id?: unknown;
  release_tag?: unknown;
  published_at?: unknown;
  headline?: unknown;
  summary?: unknown;
}

export const whatsNew = defineTool({
  name: 'whats_new',
  title: "What's new",
  description: `Lists recent Bike4Mind release notes, newest first. Paginated. Needs no key. ${UNTRUSTED_NOTE}`,
  toolset: 'about',
  scope: null,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: paginationInput,
  outputSchema: envelope(z.object({ notes: z.array(noteSchema), next_cursor: z.string().nullable() })),
  async handler({ limit, cursor }, ctx) {
    const res = await ctx.transport.call('listWhatsNew', { query: { limit, cursor } });
    if (res.status !== 200) return fail(`Listing release notes failed with HTTP ${res.status}. Try again shortly.`);
    const body = (res.json ?? {}) as { data?: UpstreamNote[]; next_cursor?: unknown };
    const notes = (body.data ?? []).map(n => ({
      id: String(n.id ?? ''),
      release_tag: String(n.release_tag ?? ''),
      published_at: String(n.published_at ?? ''),
      untrusted_title: String(n.headline ?? ''),
      untrusted_body: String(n.summary ?? ''),
    }));
    return ok({ notes, next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null });
  },
});
