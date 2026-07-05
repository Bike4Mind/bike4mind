import { describe, it, expect, vi } from 'vitest';

// vi.hoisted runs before vi.mock hoisting, making mockDlqUrls available in the factory
const mockDlqUrls = vi.hoisted(() => ({
  'fab-file-vectorize': 'https://sqs.us-east-2.amazonaws.com/123456789/fabFileVectorizeQueueDLQ',
  'fab-file-chunk': 'https://sqs.us-east-2.amazonaws.com/123456789/fabFileChunkQueueDLQ',
  'image-generation': 'https://sqs.us-east-2.amazonaws.com/123456789/imageGenerationDLQ',
  'image-edit': 'https://sqs.us-east-2.amazonaws.com/123456789/imageEditDLQ',
  'video-generation': 'https://sqs.us-east-2.amazonaws.com/123456789/videoGenerationDLQ',
  'research-engine': 'https://sqs.us-east-2.amazonaws.com/123456789/researchEngineQueueDLQ',
  'whats-new-generation': 'https://sqs.us-east-2.amazonaws.com/123456789/whatsNewGenerationQueueDLQ',
  'whats-new-highlights': 'https://sqs.us-east-2.amazonaws.com/123456789/whatsNewHighlightsQueueDLQ',
  'notebook-curation': 'https://sqs.us-east-2.amazonaws.com/123456789/notebookCurationQueueDLQ',
  'agent-proactive-message': 'https://sqs.us-east-2.amazonaws.com/123456789/agentProactiveMessageQueueDLQ',
  'slack-export': 'https://sqs.us-east-2.amazonaws.com/123456789/slackExportQueueDLQ',
  'github-webhook': 'https://sqs.us-east-2.amazonaws.com/123456789/githubWebhookQueueDLQ',
  'webhook-delivery': 'https://sqs.us-east-2.amazonaws.com/123456789/webhookDeliveryQueueDLQ',
  'quest-export': 'https://sqs.us-east-2.amazonaws.com/123456789/questExportQueueDLQ',
  'liveops-triage': 'https://sqs.us-east-2.amazonaws.com/123456789/liveOpsTriageQueueDLQ',
  'email-ingestion': 'https://sqs.us-east-2.amazonaws.com/123456789/emailIngestionQueueDLQ',
  'email-analysis': 'https://sqs.us-east-2.amazonaws.com/123456789/emailAnalysisQueueDLQ',
  'email-batch': 'https://sqs.us-east-2.amazonaws.com/123456789/emailBatchQueueDLQ',
  'email-job': 'https://sqs.us-east-2.amazonaws.com/123456789/emailJobQueueDLQ',
  'tavern-heartbeat': 'https://sqs.us-east-2.amazonaws.com/123456789/tavernHeartbeatQueueDLQ',
  'deep-agent-wake': 'https://sqs.us-east-2.amazonaws.com/123456789/deepAgentWakeQueueDLQ',
  'sre-fix': 'https://sqs.us-east-2.amazonaws.com/123456789/sreFixQueueDLQ',
  'sre-job': 'https://sqs.us-east-2.amazonaws.com/123456789/sreJobQueueDLQ',
  'secops-triage': 'https://sqs.us-east-2.amazonaws.com/123456789/secopsTriageQueueDLQ',
  'overwatch-analytics': 'https://sqs.us-east-2.amazonaws.com/123456789/overwatchAnalyticsQueueDLQ',
  'agent-continuation': 'https://sqs.us-east-2.amazonaws.com/123456789/agentContinuationQueueDLQ',
  'optihashi-run-completion': 'https://sqs.us-east-2.amazonaws.com/123456789/optihashiRunCompletionQueueDLQ',
}));

const mockSourceQueueUrls = vi.hoisted(() => ({
  fabFileVectorizeQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/fabFileVectorizeQueue',
  fabFileChunkQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/fabFileChunkQueue',
  imageGenerationQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/imageGenerationQueue',
  imageEditQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/imageEditQueue',
  videoGenerationQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/videoGenerationQueue',
  researchEngineQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/researchEngineQueue',
  whatsNewGenerationQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/whatsNewGenerationQueue',
  whatsNewHighlightsQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/whatsNewHighlightsQueue',
  notebookCurationQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/notebookCurationQueue',
  agentProactiveMessageQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/agentProactiveMessageQueue',
  slackExportQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/slackExportQueue',
  githubWebhookQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/githubWebhookQueue',
  webhookDeliveryQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/webhookDeliveryQueue',
  questExportQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/questExportQueue',
  liveOpsTriageQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/liveOpsTriageQueue',
  emailIngestionQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/emailIngestionQueue',
  emailAnalysisQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/emailAnalysisQueue',
  emailBatchQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/emailBatchQueue',
  emailJobQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/emailJobQueue',
  tavernHeartbeatQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/tavernHeartbeatQueue',
  deepAgentWakeQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/deepAgentWakeQueue',
  sreFixQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/sreFixQueue',
  sreJobQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/sreJobQueue',
  secopsTriageQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/secopsTriageQueue',
  overwatchAnalyticsQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/overwatchAnalyticsQueue',
  agentContinuationQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/agentContinuationQueue',
  optihashiRunCompletionQueue: 'https://sqs.us-east-2.amazonaws.com/123456789/optihashiRunCompletionQueue',
}));

// Mock SST Resource bindings: both DLQ and source queue URLs via Linkables
vi.mock('sst', () => ({
  Resource: {
    dlqUrls: mockDlqUrls,
    sourceQueueUrls: mockSourceQueueUrls,
  },
}));

import { getDlqRegistry, getDlqByLabel, getSourceQueueUrl, getDlqUrl } from './dlqRegistry';

describe('dlqRegistry', () => {
  describe('getDlqRegistry', () => {
    it('returns all 27 DLQ entries', () => {
      const registry = getDlqRegistry();
      expect(registry).toHaveLength(27);
    });

    it('each entry has required fields', () => {
      for (const entry of getDlqRegistry()) {
        expect(entry.label).toBeTruthy();
        expect(entry.displayName).toBeTruthy();
        expect(entry.application).toBeTruthy();
        expect(entry.sourceQueue).toBeTruthy();
      }
    });

    it('labels are unique', () => {
      const labels = getDlqRegistry().map(e => e.label);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it('getDlqUrl returns DLQ URL from Resource.dlqUrls Linkable', () => {
      for (const entry of getDlqRegistry()) {
        const dlqUrl = getDlqUrl(entry.label);
        expect(typeof dlqUrl).toBe('string');
        expect(dlqUrl).toContain('sqs.us-east-2.amazonaws.com');
        expect(dlqUrl).toBe(mockDlqUrls[entry.label as keyof typeof mockDlqUrls]);
      }
    });

    it('getSourceQueueUrl returns source URL from Resource binding', () => {
      for (const entry of getDlqRegistry()) {
        const sourceUrl = getSourceQueueUrl(entry.sourceQueue as Parameters<typeof getSourceQueueUrl>[0]);
        expect(typeof sourceUrl).toBe('string');
        expect(sourceUrl).toContain('sqs.us-east-2.amazonaws.com');
      }
    });

    it('includes tavern-heartbeat entry', () => {
      const tavernEntry = getDlqRegistry().find(e => e.label === 'tavern-heartbeat');
      expect(tavernEntry).toBeDefined();
      expect(tavernEntry!.displayName).toBe('Tavern Heartbeat');
      expect(tavernEntry!.application).toBe('TavernHeartbeat');
    });
  });

  describe('getDlqByLabel', () => {
    it('returns the correct entry for a known label', () => {
      const entry = getDlqByLabel('slack-export');
      expect(entry).toBeDefined();
      expect(entry!.displayName).toBe('Slack Export');
      expect(entry!.application).toBe('SlackExport');
    });

    it('returns undefined for an unknown label', () => {
      expect(getDlqByLabel('nonexistent-queue')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(getDlqByLabel('')).toBeUndefined();
    });
  });

  describe('getSourceQueueUrl', () => {
    it('returns URL for a valid queue name', () => {
      const url = getSourceQueueUrl('imageGenerationQueue');
      expect(url).toBe('https://sqs.us-east-2.amazonaws.com/123456789/imageGenerationQueue');
    });

    it('returns URL for all queue names in the Linkable', () => {
      for (const [name, expectedUrl] of Object.entries(mockSourceQueueUrls)) {
        // SourceQueueName type is enforced at compile time; cast here since we're iterating mock keys
        const url = getSourceQueueUrl(name as Parameters<typeof getSourceQueueUrl>[0]);
        expect(url).toBe(expectedUrl);
      }
    });

    it('throws descriptive error for invalid queue name', () => {
      // @ts-expect-error testing runtime behavior with invalid name
      expect(() => getSourceQueueUrl('nonExistentQueue')).toThrow('Missing source queue URL for: nonExistentQueue');
    });
  });
});
