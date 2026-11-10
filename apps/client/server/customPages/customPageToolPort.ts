import { Resource } from 'sst';
import { Connection, customPageRepository } from '@bike4mind/database';
import { PAGE_QUERY_KEY } from '@bike4mind/common';
import { customPageService } from '@bike4mind/services';
import type { CustomPageToolPort } from '@bike4mind/services/llm';
import { ClientMessageSender } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';

/**
 * Host port behind the page_* LLM tools: runs the same customPageService mutations as the REST API,
 * then asks the owner's open tabs to refetch the page. A failed push is logged, never thrown, since
 * the write already succeeded and the page also refreshes on its next fetch.
 */
export function createCustomPageToolPort({ logger }: { logger: Logger }): CustomPageToolPort {
  const adapters = { db: { customPages: customPageRepository } };
  const sender = new ClientMessageSender({ connections: Connection }, logger);

  const invalidate = async (userId: string, pageId: string) => {
    try {
      await sender.sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: [...PAGE_QUERY_KEY(pageId)],
      });
    } catch (error) {
      logger.warn('custom page invalidate_query send failed', { pageId, error });
    }
  };

  const afterWrite = async (userId: string, pageId: string, result: customPageService.CustomPageResult) => {
    if (result.ok) await invalidate(userId, pageId);
    return result;
  };

  return {
    async findForSession(sessionId, userId) {
      const page = await customPageRepository.findByOrchestratorSession(sessionId, userId);
      if (!page) return null;
      return { id: String(page.id), name: page.name, state: page.state, widgets: page.widgets };
    },
    async patchState(params) {
      return afterWrite(params.userId, params.pageId, await customPageService.patchState(params, adapters));
    },
    async setWidget(params) {
      return afterWrite(params.userId, params.pageId, await customPageService.setWidget(params, adapters));
    },
    async removeWidget(params) {
      return afterWrite(params.userId, params.pageId, await customPageService.removeWidget(params, adapters));
    },
  };
}
