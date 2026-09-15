import type { Logger } from './Logger';

/**
 * StreamLogger manages intelligent batching of SSE stream debug logs.
 *
 * Dual-threshold batching: Logs every 200 chars OR 500ms, whichever comes first.
 *
 * Format: [ServerLlmBackend] Streaming... events #1-30, 253 chars (+253, 0.5s) "...last 30 chars"
 */
export class StreamLogger {
  // Configuration thresholds
  private static readonly CHAR_THRESHOLD = 200;
  private static readonly TIME_THRESHOLD_MS = 500;
  private static readonly PREVIEW_LENGTH = 30;
  private static readonly MAX_FULL_TEXT_LENGTH = 10000;

  // State tracking
  private startEventNum: number = 0;
  private currentEventNum: number = 0;
  private lastLoggedLength: number = 0;
  private totalLength: number = 0;
  private lastLogTime: number = 0;
  private streamStartTime: number = 0;
  private lastPreview: string = '';

  // Mode flags
  private readonly ultraVerbose: boolean;
  private readonly verbose: boolean;

  // Logger reference and context
  private readonly logger: Logger;
  private readonly context: string;

  constructor(logger: Logger, context: string, verbose: boolean = false, ultraVerbose: boolean = false) {
    this.logger = logger;
    this.context = context;
    this.verbose = verbose;
    this.ultraVerbose = ultraVerbose;
  }

  /**
   * Called when stream starts
   */
  streamStart(): void {
    this.streamStartTime = Date.now();
    this.lastLogTime = this.streamStartTime;
    this.startEventNum = 0;
    this.currentEventNum = 0;
    this.lastLoggedLength = 0;
    this.totalLength = 0;
    this.lastPreview = '';

    // Always log stream start immediately (critical event)
    this.logger.debug(`[${this.context}] Stream started`);
  }

  /**
   * Called on each SSE event
   */
  onEvent(eventNum: number, eventData: string): void {
    this.currentEventNum = eventNum;

    // Ultra-verbose mode: log every event
    if (this.ultraVerbose) {
      this.logger.debug(`[${this.context}] SSE event #${eventNum}, data: ${eventData.substring(0, 100)}`);
    }
  }

  /**
   * Called when content is accumulated
   */
  onContent(eventNum: number, textChunk: string, totalAccumulated: string): void {
    this.currentEventNum = eventNum;
    this.totalLength = totalAccumulated.length;

    // Extract last chars for preview, sanitize for single-line display
    const rawPreview = totalAccumulated.slice(-StreamLogger.PREVIEW_LENGTH);
    this.lastPreview = this.sanitizePreview(rawPreview);

    // Ultra-verbose mode: log every content event
    if (this.ultraVerbose) {
      this.logger.debug(`[${this.context}] Content event #${eventNum}, chunk: "${textChunk}"`);
      this.logger.debug(`[${this.context}] Accumulated text length: ${this.totalLength}`);
      return;
    }

    // Only batch in verbose mode
    if (!this.verbose) {
      return;
    }

    // Check dual thresholds
    const charsDelta = this.totalLength - this.lastLoggedLength;
    const timeDelta = Date.now() - this.lastLogTime;

    if (charsDelta >= StreamLogger.CHAR_THRESHOLD || timeDelta >= StreamLogger.TIME_THRESHOLD_MS) {
      this.flushBatch();
    }
  }

  /**
   * Called for non-content events (tool_use, errors, etc.)
   * These are always logged immediately (critical events)
   */
  onCriticalEvent(eventNum: number, eventType: string, description: string): void {
    this.currentEventNum = eventNum;

    // Flush any pending batch before critical event
    if (this.verbose && !this.ultraVerbose) {
      const charsDelta = this.totalLength - this.lastLoggedLength;
      if (charsDelta > 0) {
        this.flushBatch();
      }
    }

    // Always log critical events immediately
    this.logger.debug(`[${this.context}] ${eventType} event #${eventNum}: ${description}`);
  }

  /**
   * Called when stream completes
   */
  streamComplete(totalText: string): void {
    // Flush any pending batch
    if (this.verbose && !this.ultraVerbose) {
      const charsDelta = this.totalLength - this.lastLoggedLength;
      if (charsDelta > 0) {
        this.flushBatch();
      }
    }

    // Log stream completion
    const totalTime = Date.now() - this.streamStartTime;
    this.logger.debug(
      `[${this.context}] Stream complete: ${this.currentEventNum} events, ${this.totalLength} chars, ${(totalTime / 1000).toFixed(2)}s`
    );

    // Log full text (truncated if huge)
    if (totalText.length > StreamLogger.MAX_FULL_TEXT_LENGTH) {
      const truncated = totalText.substring(0, StreamLogger.MAX_FULL_TEXT_LENGTH);
      this.logger.debug(
        `[${this.context}] Full text (truncated to ${StreamLogger.MAX_FULL_TEXT_LENGTH} chars):\n${truncated}\n... [+${totalText.length - StreamLogger.MAX_FULL_TEXT_LENGTH} more chars]`
      );
    } else if (totalText.length > 0) {
      this.logger.debug(`[${this.context}] Full text:\n${totalText}`);
    }
  }

  /**
   * Called when stream fails
   */
  streamError(error: unknown): void {
    // Flush any pending batch before error
    if (this.verbose && !this.ultraVerbose) {
      const charsDelta = this.totalLength - this.lastLoggedLength;
      if (charsDelta > 0) {
        this.flushBatch();
      }
    }

    this.logger.error(`[${this.context}] Stream error:`, error);
  }

  /**
   * Flush the current batch to console
   */
  private flushBatch(): void {
    const charsDelta = this.totalLength - this.lastLoggedLength;
    const timeDelta = Date.now() - this.lastLogTime;

    // Format: [ServerLlmBackend] Streaming... events #1-30, 253 chars (+253, 0.5s) "...last 30 chars"
    const eventRange =
      this.startEventNum === this.currentEventNum
        ? `#${this.currentEventNum}`
        : `#${this.startEventNum}-${this.currentEventNum}`;

    const preview = this.lastPreview.length > 0 ? ` "...${this.lastPreview}"` : '';

    this.logger.debug(
      `[${this.context}] Streaming... events ${eventRange}, ${this.totalLength} chars (+${charsDelta}, ${(timeDelta / 1000).toFixed(1)}s)${preview}`
    );

    // Update state
    this.lastLoggedLength = this.totalLength;
    this.lastLogTime = Date.now();
    this.startEventNum = this.currentEventNum + 1; // Next batch starts at next event
  }

  /**
   * Sanitize preview text for single-line display
   * Replaces newlines and control characters with spaces
   */
  private sanitizePreview(text: string): string {
    return text.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ');
  }

  /**
   * Reset state for new stream
   */
  reset(): void {
    this.startEventNum = 0;
    this.currentEventNum = 0;
    this.lastLoggedLength = 0;
    this.totalLength = 0;
    this.lastLogTime = 0;
    this.streamStartTime = 0;
    this.lastPreview = '';
  }
}
