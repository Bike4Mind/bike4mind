import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { IQueueService } from './types';

export class SQSService implements IQueueService {
  private sqsClient: SQSClient;

  constructor() {
    this.sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });
  }

  async sendMessage(queueUrl: string | undefined, message: Record<string, unknown>): Promise<string | undefined> {
    if (!queueUrl) throw new Error(`Queue URL ${queueUrl} not found`);
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    });
    const response = await this.sqsClient.send(command);
    return response.MessageId;
  }
}
