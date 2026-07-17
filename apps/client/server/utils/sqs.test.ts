import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: vi.fn().mockImplementation(function () {
      return { send: mockSend };
    }),
    SendMessageCommand: vi.fn().mockImplementation(function (input) {
      return { input };
    }),
    ReceiveMessageCommand: vi.fn().mockImplementation(function (input) {
      return { input };
    }),
    DeleteMessageCommand: vi.fn().mockImplementation(function (input) {
      return { input };
    }),
    GetQueueAttributesCommand: vi.fn().mockImplementation(function (input) {
      return { input };
    }),
  };
});

import { sendToQueue, receiveFromQueue, deleteFromQueue, getQueueAttributes } from './sqs';

const TEST_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/test-queue';

describe('sqs utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendToQueue', () => {
    it('sends a JSON-stringified message and returns the MessageId', async () => {
      mockSend.mockResolvedValueOnce({ MessageId: 'msg-123' });

      const result = await sendToQueue(TEST_QUEUE_URL, { foo: 'bar' });

      expect(result).toBe('msg-123');
      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.QueueUrl).toBe(TEST_QUEUE_URL);
      expect(cmd.input.MessageBody).toBe(JSON.stringify({ foo: 'bar' }));
    });
  });

  describe('receiveFromQueue', () => {
    it('returns messages from the queue', async () => {
      const messages = [{ MessageId: 'msg-1', Body: '{}' }];
      mockSend.mockResolvedValueOnce({ Messages: messages });

      const result = await receiveFromQueue(TEST_QUEUE_URL, 5);

      expect(result).toEqual(messages);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.QueueUrl).toBe(TEST_QUEUE_URL);
      expect(cmd.input.MaxNumberOfMessages).toBe(5);
      expect(cmd.input.WaitTimeSeconds).toBe(0);
    });

    it('returns empty array when no messages', async () => {
      mockSend.mockResolvedValueOnce({ Messages: undefined });

      const result = await receiveFromQueue(TEST_QUEUE_URL, 5);
      expect(result).toEqual([]);
    });

    it('clamps maxMessages to [1, 10]', async () => {
      mockSend.mockResolvedValue({ Messages: [] });

      await receiveFromQueue(TEST_QUEUE_URL, 0);
      expect(mockSend.mock.calls[0][0].input.MaxNumberOfMessages).toBe(1);

      await receiveFromQueue(TEST_QUEUE_URL, 20);
      expect(mockSend.mock.calls[1][0].input.MaxNumberOfMessages).toBe(10);
    });

    it('uses custom visibility timeout', async () => {
      mockSend.mockResolvedValueOnce({ Messages: [] });

      await receiveFromQueue(TEST_QUEUE_URL, 1, 60);

      expect(mockSend.mock.calls[0][0].input.VisibilityTimeout).toBe(60);
    });

    it('defaults visibility timeout to 30', async () => {
      mockSend.mockResolvedValueOnce({ Messages: [] });

      await receiveFromQueue(TEST_QUEUE_URL, 1);

      expect(mockSend.mock.calls[0][0].input.VisibilityTimeout).toBe(30);
    });

    it('defaults waitTimeSeconds to 0 (short polling) for existing callers', async () => {
      mockSend.mockResolvedValueOnce({ Messages: [] });

      await receiveFromQueue(TEST_QUEUE_URL, 1, 30);

      expect(mockSend.mock.calls[0][0].input.WaitTimeSeconds).toBe(0);
    });

    it('long-polls when waitTimeSeconds is passed, clamped to [0, 20]', async () => {
      mockSend.mockResolvedValue({ Messages: [] });

      await receiveFromQueue(TEST_QUEUE_URL, 1, 30, 20);
      expect(mockSend.mock.calls[0][0].input.WaitTimeSeconds).toBe(20);

      await receiveFromQueue(TEST_QUEUE_URL, 1, 30, 99);
      expect(mockSend.mock.calls[1][0].input.WaitTimeSeconds).toBe(20);

      await receiveFromQueue(TEST_QUEUE_URL, 1, 30, -5);
      expect(mockSend.mock.calls[2][0].input.WaitTimeSeconds).toBe(0);
    });
  });

  describe('deleteFromQueue', () => {
    it('deletes a message by receipt handle', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteFromQueue(TEST_QUEUE_URL, 'receipt-handle-abc');

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.QueueUrl).toBe(TEST_QUEUE_URL);
      expect(cmd.input.ReceiptHandle).toBe('receipt-handle-abc');
    });
  });

  describe('getQueueAttributes', () => {
    it('returns parsed message counts', async () => {
      mockSend.mockResolvedValueOnce({
        Attributes: {
          ApproximateNumberOfMessages: '42',
          ApproximateNumberOfMessagesNotVisible: '3',
        },
      });

      const result = await getQueueAttributes(TEST_QUEUE_URL);

      expect(result).toEqual({
        approximateMessageCount: 42,
        approximateNotVisibleCount: 3,
      });
    });

    it('defaults to 0 when attributes are missing', async () => {
      mockSend.mockResolvedValueOnce({ Attributes: undefined });

      const result = await getQueueAttributes(TEST_QUEUE_URL);

      expect(result).toEqual({
        approximateMessageCount: 0,
        approximateNotVisibleCount: 0,
      });
    });
  });
});
