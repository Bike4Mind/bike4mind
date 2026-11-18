import { handler as runCloudScan } from '@bike4mind/server-utils/security/cloudScan';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';

const sqsClient = new SQSClient({});

export const handler = async (event?: { trigger?: string }): Promise<void> => {
  const snapshot = await runCloudScan();
  if (event?.trigger !== 'manual') return;

  const findings = snapshot.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  if (findings.length === 0) return;

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: Resource.secopsTriageQueue.url,
        MessageBody: JSON.stringify({
          stage: snapshot.stage,
          scanSource: 'cloud',
          snapshotId: snapshot.id,
          targetUrl: 'aws:cloud-infrastructure',
          findings: findings.map(f => ({
            id: f.id,
            title: f.title,
            severity: f.severity,
            description: f.description,
            recommendation: f.recommendation,
            documentationUrl: f.documentationUrl,
            instances: [],
          })),
        }),
      })
    );
    Logger.info('SecOps Triage: published Cloud findings to SQS', {
      stage: snapshot.stage,
      findingCount: findings.length,
    });
  } catch (error) {
    Logger.error('SecOps Triage: failed to publish Cloud findings to SQS (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
