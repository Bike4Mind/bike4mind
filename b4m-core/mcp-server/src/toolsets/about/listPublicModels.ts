import { z } from 'zod';
import { envelope, fail, ok, paginationInput, UNTRUSTED_NOTE } from '../../results';
import { defineTool } from '../../tool';

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  untrusted_provider_label: z.string().nullable(),
  modality: z.string(),
});

interface UpstreamModel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  backend?: unknown;
  provider_label?: unknown;
}

const CURSOR_HINT =
  'The cursor is not valid for this tool. Omit cursor, or pass the exact next_cursor this tool returned.';

export const listPublicModels = defineTool({
  name: 'list_public_models',
  title: 'List models',
  description:
    'Lists the AI models available on Bike4Mind: id, name, provider and modality (text, image, speech-to-text, ' +
    `video). Paginated. Needs a Bike4Mind key with ai:chat or ai:generate. ${UNTRUSTED_NOTE}`,
  toolset: 'about',
  // Listed without a key so the tool is discoverable; a call without a suitable key returns guidance instead.
  scope: null,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: paginationInput,
  outputSchema: envelope(z.object({ models: z.array(modelSchema), next_cursor: z.string().nullable() })),
  async handler({ limit, cursor }, ctx) {
    const res = await ctx.transport.call('listModels', { query: { limit, cursor } });
    if (res.status === 401 || res.status === 403) {
      return fail(
        `Listing models needs a Bike4Mind key with the ai:chat or ai:generate scope. Create one at ${ctx.baseUrl.replace(/\/+$/, '')} under Profile > API Keys and reconnect with it.`
      );
    }
    if (res.status === 422) return fail(CURSOR_HINT);
    if (res.status !== 200) return fail(`Listing models failed with HTTP ${res.status}. Try again shortly.`);
    const body = (res.json ?? {}) as { data?: UpstreamModel[]; next_cursor?: unknown };
    const models = (body.data ?? []).map(m => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      provider: String(m.backend ?? ''),
      untrusted_provider_label: typeof m.provider_label === 'string' ? m.provider_label : null,
      modality: String(m.type ?? ''),
    }));
    return ok({ models, next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null });
  },
});
