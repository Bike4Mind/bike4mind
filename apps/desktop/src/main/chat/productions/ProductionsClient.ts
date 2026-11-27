import { z } from 'zod';
import { isAxiosError } from 'axios';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  StudioCompositionResponseSchema,
  StudioCompositionSummaryResponseSchema,
  StudioRenderCreateResponseSchema,
  StudioRenderJobListSchema,
  type StudioCompositionResponse,
  type StudioCompositionSummaryResponse,
  type StudioRenderJob,
  type StudioTimeline,
} from '@bike4mind/common';
import type { ProductionsErrorKind } from '@shared/productions';

const ItemResponseSchema = z.object({ composition: StudioCompositionResponseSchema });
const ListResponseSchema = z.object({ data: z.array(StudioCompositionSummaryResponseSchema) });

/** ms. A render submit prices and holds credits per output before answering. */
const TIMEOUT_MS = { read: 30_000, write: 60_000 } as const;

const BASE = '/api/studio/compositions';
const itemPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export class ProductionsError extends Error {
  constructor(
    readonly kind: ProductionsErrorKind,
    message: string
  ) {
    super(message);
  }
}

const ErrorBodySchema = z.object({
  code: z.string().max(100).optional().catch(undefined),
  error: z.string().max(200).optional().catch(undefined),
  message: z.string().max(1000).optional().catch(undefined),
});

export const NOT_ENABLED_MESSAGE = 'Productions is not enabled for your account yet.';

/**
 * Map a failed call to what the tab acts on. The rollout gate answers 403 `FEATURE_DISABLED` on
 * every route; a 404 on the list route (which has no id to miss) means a server without the routes.
 */
export function toProductionsError(error: unknown, action: string, route: 'list' | 'item'): ProductionsError {
  if (error instanceof ProductionsError) return error;
  if (!isAxiosError(error)) {
    if (error instanceof z.ZodError)
      return new ProductionsError('failed', `${action} failed: the server sent an unexpected reply.`);
    return new ProductionsError(
      'failed',
      `${action} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const status = error.response?.status;
  const parsed = ErrorBodySchema.safeParse(error.response?.data);
  const body = parsed.success ? parsed.data : {};
  if (status === 403 && body.code === 'FEATURE_DISABLED')
    return new ProductionsError('not-enabled', NOT_ENABLED_MESSAGE);
  if (status === 404 && route === 'list') return new ProductionsError('not-enabled', NOT_ENABLED_MESSAGE);
  if (status === 404) return new ProductionsError('not-found', 'This production does not exist or is not yours.');
  if (status === 401)
    return new ProductionsError('signed-out', 'Your session ended. Sign in again to see Productions.');
  const detail = body.message ?? body.error;
  if (detail) return new ProductionsError('failed', `${action} failed: ${detail}`);
  if (status) return new ProductionsError('failed', `${action} failed with HTTP ${status}.`);
  return new ProductionsError('failed', `${action} failed: ${error.message}`);
}

/** The compositions and renders routes, each response checked against the shared schema. */
export class ProductionsClient {
  constructor(private readonly api: AuthenticatedApiClient) {}

  async list(query: { limit: number; skip: number }): Promise<StudioCompositionSummaryResponse[]> {
    try {
      const response = await this.api.get<unknown>(BASE, { params: query, timeout: TIMEOUT_MS.read });
      return ListResponseSchema.parse(response).data;
    } catch (error) {
      throw toProductionsError(error, 'Listing your productions', 'list');
    }
  }

  async get(id: string): Promise<StudioCompositionResponse> {
    try {
      return ItemResponseSchema.parse(await this.api.get<unknown>(itemPath(id), { timeout: TIMEOUT_MS.read }))
        .composition;
    } catch (error) {
      throw toProductionsError(error, 'Opening the production', 'item');
    }
  }

  /** PATCH replaces each given field whole. AuthenticatedApiClient has no patch(); its axios instance carries the same auth. */
  async update(
    id: string,
    patch: { title: string } | { timeline: StudioTimeline },
    action: string
  ): Promise<StudioCompositionResponse> {
    try {
      const response = await this.api
        .getAxiosInstance()
        .patch<unknown>(itemPath(id), patch, { timeout: TIMEOUT_MS.write });
      return ItemResponseSchema.parse(response.data).composition;
    } catch (error) {
      throw toProductionsError(error, action, 'item');
    }
  }

  async renders(id: string): Promise<StudioRenderJob[]> {
    try {
      const response = await this.api.get<unknown>(`${itemPath(id)}/renders`, { timeout: TIMEOUT_MS.read });
      return StudioRenderJobListSchema.parse(response).data;
    } catch (error) {
      throw toProductionsError(error, 'Checking the exports', 'item');
    }
  }

  async render(id: string, outputIds: string[]): Promise<StudioRenderJob[]> {
    try {
      const response = await this.api.post<unknown>(
        `${itemPath(id)}/renders`,
        { outputIds },
        { timeout: TIMEOUT_MS.write }
      );
      return StudioRenderCreateResponseSchema.parse(response).jobs;
    } catch (error) {
      throw toProductionsError(error, 'Starting the export', 'item');
    }
  }
}
