import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamLogger } from './StreamLogger';
import { Logger } from './Logger';

// Mock Logger class
const createMockLogger = () => {
  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return mockLogger as unknown as Logger;
};

describe('StreamLogger', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Stream lifecycle', () => {
    it('logs stream start immediately', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] Stream started');
    });

    it('logs stream completion with stats', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      vi.advanceTimersByTime(1500);
      streamLogger.streamComplete('Hello world');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[TestContext] Stream complete: 0 events, 0 chars, 1.50s')
      );
    });

    it('logs full text on completion when text is provided', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();
      streamLogger.streamComplete('Hello world');

      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] Full text:\nHello world');
    });

    it('truncates huge responses on completion', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const hugeText = 'a'.repeat(15000);
      streamLogger.streamComplete(hugeText);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[TestContext] Full text (truncated to 10000 chars):')
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('... [+5000 more chars]'));
    });

    it('handles empty streams', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();
      streamLogger.streamComplete('');

      // Should not log empty full text
      expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Full text:'));
    });
  });

  describe('Character threshold batching', () => {
    it('flushes batch when char threshold is reached', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // Accumulate exactly 200 chars
      const text = 'a'.repeat(200);
      streamLogger.onContent(1, text, text);

      // Should flush immediately due to char threshold
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Streaming... events #0-1, 200 chars (+200')
      );
    });

    it('does not flush when under char threshold', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const calls = (mockLogger.debug as any).mock.calls.length;

      const text = 'a'.repeat(199);
      streamLogger.onContent(1, text, text);

      // Should not have flushed (only stream start should be logged)
      expect((mockLogger.debug as any).mock.calls.length).toBe(calls);
    });

    it('accumulates chars across multiple events before flushing', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // Add 100 chars (no flush)
      let accum = 'a'.repeat(100);
      streamLogger.onContent(1, accum, accum);

      // Add another 100 chars (total 200, should flush)
      const chunk2 = 'b'.repeat(100);
      accum += chunk2;
      streamLogger.onContent(2, chunk2, accum);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Streaming... events #0-2, 200 chars (+200')
      );
    });
  });

  describe('Time threshold batching', () => {
    it('flushes batch when time threshold is reached', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const text = 'a'.repeat(50); // Less than char threshold
      streamLogger.onContent(1, text, text);

      const callsBeforeTime = (mockLogger.debug as any).mock.calls.length;

      // Advance time by 500ms (time threshold)
      vi.advanceTimersByTime(500);

      // Add more content to trigger threshold check
      const accum = text + 'b';
      streamLogger.onContent(2, 'b', accum);

      // Should have flushed due to time threshold
      expect((mockLogger.debug as any).mock.calls.length).toBeGreaterThan(callsBeforeTime);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Streaming... events #0-2, 51 chars'));
    });

    it('does not flush when under time threshold', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const text = 'a'.repeat(50);
      streamLogger.onContent(1, text, text);

      const callsBefore = (mockLogger.debug as any).mock.calls.length;

      // Advance time by less than threshold
      vi.advanceTimersByTime(499);

      const accum = text + 'b';
      streamLogger.onContent(2, 'b', accum);

      // Should not have flushed yet
      expect((mockLogger.debug as any).mock.calls.length).toBe(callsBefore);
    });
  });

  describe('Dual threshold interaction', () => {
    it('triggers on char threshold when time has not elapsed', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // Add 200 chars in 100ms
      vi.advanceTimersByTime(100);
      const text = 'a'.repeat(200);
      streamLogger.onContent(1, text, text);

      // Should flush on char threshold, not wait for time
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Streaming... events #0-1, 200 chars'));
    });

    it('triggers on time threshold when chars have not accumulated', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const text = 'a'.repeat(100);
      streamLogger.onContent(1, text, text);

      // Advance time past threshold
      vi.advanceTimersByTime(600);

      const accum = text + 'b';
      streamLogger.onContent(2, 'b', accum);

      // Should flush on time threshold
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Streaming... events #0-2, 101 chars'));
    });
  });

  describe('Critical events', () => {
    it('logs critical events immediately', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      streamLogger.onCriticalEvent(1, 'TOOL_USE', 'tools: 2');

      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] TOOL_USE event #1: tools: 2');
    });

    it('flushes pending batch before critical event', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // Accumulate some content (below threshold)
      const text = 'a'.repeat(100);
      streamLogger.onContent(1, text, text);

      // Critical event should flush pending batch first
      streamLogger.onCriticalEvent(2, 'TOOL_USE', 'tools: 1');

      // Should have both batch flush and critical event
      // Note: The batch includes up to the current event (event #2), so it shows #0-2
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Streaming... events #0-2, 100 chars'));
      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] TOOL_USE event #2: tools: 1');
    });

    it('does not flush when no pending content', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const callsBefore = (mockLogger.debug as any).mock.calls.length;

      streamLogger.onCriticalEvent(1, 'ERROR', 'Server error');

      // Should only have critical event log, no batch flush
      expect((mockLogger.debug as any).mock.calls.length).toBe(callsBefore + 1);
      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] ERROR event #1: Server error');
    });
  });

  describe('Ultra-verbose mode', () => {
    it('logs every event individually in ultra-verbose mode', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, true);
      streamLogger.streamStart();

      streamLogger.onEvent(1, '{"type":"content","text":"hello"}');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[TestContext] SSE event #1, data: {"type":"content","text":"hello"}'
      );
    });

    it('logs every content event individually in ultra-verbose mode', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, true);
      streamLogger.streamStart();

      streamLogger.onContent(1, 'hello', 'hello');

      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] Content event #1, chunk: "hello"');
      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] Accumulated text length: 5');
    });

    it('bypasses batching in ultra-verbose mode', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, true);
      streamLogger.streamStart();

      // Even with 1000 chars, should not batch
      const text = 'a'.repeat(1000);
      streamLogger.onContent(1, text, text);

      // Should not have batch log
      expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Streaming...'));
      // Should have individual content logs
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Content event #1'));
    });
  });

  describe('Preview extraction', () => {
    it('includes last 30 chars in preview', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const longText = 'a'.repeat(200) + 'This is the end of text';
      streamLogger.onContent(1, longText, longText);

      // Preview should include the last 30 chars
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('This is the end of text'));
    });

    it('shows full text when less than 30 chars', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const text = 'a'.repeat(200);
      streamLogger.onContent(1, text, text);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('"...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'));
    });
  });

  describe('Event range formatting', () => {
    it('shows single event number when batch has one event', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const text = 'a'.repeat(200);
      streamLogger.onContent(1, text, text);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('events #0-1'));
    });

    it('shows event range when batch has multiple events', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      let accum = '';
      for (let i = 1; i <= 10; i++) {
        const chunk = 'a'.repeat(20);
        accum += chunk;
        streamLogger.onContent(i, chunk, accum);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('events #0-10'));
    });

    it('resets event range after flush', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // First batch
      let accum = 'a'.repeat(200);
      streamLogger.onContent(10, accum, accum);

      // Clear mock to check next batch
      (mockLogger.debug as any).mockClear();

      // Second batch
      const chunk2 = 'b'.repeat(200);
      accum += chunk2;
      streamLogger.onContent(20, chunk2, accum);

      // Next batch should start from event 11
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('events #11-20'));
    });
  });

  describe('Error handling', () => {
    it('logs stream errors', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      const error = new Error('Parse error');
      streamLogger.streamError(error);

      expect(mockLogger.error).toHaveBeenCalledWith('[TestContext] Stream error:', error);
    });

    it('flushes pending batch before logging error', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // Accumulate some content
      const text = 'a'.repeat(100);
      streamLogger.onContent(1, text, text);

      // Error should flush pending batch
      const error = new Error('Parse error');
      streamLogger.streamError(error);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Streaming... events #0-1, 100 chars'));
      expect(mockLogger.error).toHaveBeenCalledWith('[TestContext] Stream error:', error);
    });
  });

  describe('Non-verbose mode', () => {
    it('does not log batches when verbose is false', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', false, false);
      streamLogger.streamStart();

      const text = 'a'.repeat(300);
      streamLogger.onContent(1, text, text);

      // Should only have stream start, no batch logs
      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] Stream started');
      expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Streaming...'));
    });

    it('still logs critical events when verbose is false', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', false, false);
      streamLogger.streamStart();

      streamLogger.onCriticalEvent(1, 'ERROR', 'Server error');

      expect(mockLogger.debug).toHaveBeenCalledWith('[TestContext] ERROR event #1: Server error');
    });
  });

  describe('Reset functionality', () => {
    it('resets state for new stream', () => {
      const streamLogger = new StreamLogger(mockLogger, 'TestContext', true, false);
      streamLogger.streamStart();

      // Use 200+ chars to trigger batch flush
      const text = 'a'.repeat(200);
      streamLogger.onContent(1, text, text);

      streamLogger.reset();

      // After reset, should start from event 0 again
      streamLogger.streamStart();
      streamLogger.onContent(1, text, text);

      // Both batches should start from #0
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('events #0-1, 200 chars (+200'));
    });
  });
});
