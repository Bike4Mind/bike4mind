export interface IQueueService {
  sendMessage(queueUrl: string | undefined, message: Record<string, unknown>): Promise<string | undefined>;
}
