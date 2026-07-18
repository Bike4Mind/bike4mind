import { IResearchTask, IResearchTaskJobs } from '@bike4mind/common';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';

// Resource.researchEngineQueue.url (not getSourceQueueUrl): the hosted sourceQueueUrls
// Linkable is populated from this same queue's .url, so hosted resolves identically, and
// it also resolves under the self-host Resource shim (getSourceQueueUrl reads a record the
// shim doesn't provide, and would throw). Keep in sync with the worker consumer.

class ResearchTaskJobs implements IResearchTaskJobs {
  async process(id: string, userId: string): Promise<void> {
    try {
      await sendToQueue(Resource.researchEngineQueue.url, {
        action: 'process',
        payload: {
          id,
          userId,
        },
      });
      console.log(`✅ [QUEUE_SUCCESS] Successfully queued research task ${id}`);
    } catch (queueError) {
      console.error(`❌ [QUEUE_ERROR] Failed to queue research task ${id}:`, queueError);
      throw queueError;
    }
  }
  async processDiscoveredLinks(id: string, userId: string): Promise<void> {
    await sendToQueue(Resource.researchEngineQueue.url, {
      action: 'processDiscoveredLinks',
      payload: {
        id,
        userId,
      },
    });
  }

  async downloadRelevantLinks(id: string, userId: string): Promise<void> {
    await sendToQueue(Resource.researchEngineQueue.url, {
      action: 'downloadRelevantLinks',
      payload: {
        id,
        userId,
      },
    });
  }

  async sendToClient(
    researchTask: IResearchTask,
    update: { status: string; currentStep: string; progress: number }
  ): Promise<void> {
    console.log('SENDING TO CLIENT');
    await sendToClient(researchTask.userId, Resource.websocket.managementEndpoint, {
      action: 'research_task_status_update',
      status: update.status,
      taskId: researchTask.id,
      currentStep: update.currentStep,
      progress: update.progress,
    });
  }
}

export const researchTaskJobs = new ResearchTaskJobs();
