import { Logger } from '@bike4mind/observability';
import { LlmTools } from './index';
import { ToolCacheManager } from './ToolCacheManager';

/**
 * Retry configuration for tool execution
 */
interface RetryConfig {
  maxRetries: number;
  initialDelay: number; // milliseconds
  maxDelay: number; // milliseconds
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 100,
  maxDelay: 5000,
  backoffMultiplier: 2,
};

/**
 * Tool execution result
 */
export interface ToolExecutionResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  attempts: number;
  totalDuration: number;
}

/**
 * Validates tool availability and handles retry logic for tool failures
 */
export class ToolValidator {
  private logger: Logger;
  private cacheManager: ToolCacheManager;
  private retryConfig: RetryConfig;

  constructor(logger: Logger, cacheManager: ToolCacheManager, retryConfig: Partial<RetryConfig> = {}) {
    this.logger = logger;
    this.cacheManager = cacheManager;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Validate if a tool is available before execution
   */
  validateToolAvailability(sessionId: string, toolName: LlmTools): { valid: boolean; reason?: string } {
    const isAvailable = this.cacheManager.isToolAvailable(sessionId, toolName);
    const toolState = this.cacheManager.getToolState(sessionId, toolName);

    if (!isAvailable) {
      return {
        valid: false,
        reason: `Tool ${toolName} is currently unavailable. ${
          toolState?.lastError ? `Last error: ${toolState.lastError}` : ''
        }`,
      };
    }

    return { valid: true };
  }

  /**
   * Execute a tool with retry logic
   */
  async executeToolWithRetry<T = any>(
    sessionId: string,
    toolName: LlmTools,
    toolFn: () => Promise<T>
  ): Promise<ToolExecutionResult<T>> {
    const startTime = Date.now();
    let attempts = 0;
    let lastError: Error | null = null;

    // Validate tool availability before attempting execution
    const validation = this.validateToolAvailability(sessionId, toolName);
    if (!validation.valid) {
      this.logger.warn(`🔧 [ToolValidator] Tool ${toolName} validation failed: ${validation.reason}`);
      return {
        success: false,
        error: validation.reason,
        attempts: 0,
        totalDuration: Date.now() - startTime,
      };
    }

    // Attempt execution with exponential backoff
    for (let i = 0; i <= this.retryConfig.maxRetries; i++) {
      attempts++;

      try {
        this.logger.debug(
          `🔧 [ToolValidator] Executing tool ${toolName} (attempt ${attempts}/${this.retryConfig.maxRetries + 1})`
        );

        const result = await toolFn();

        // Mark success in cache
        this.cacheManager.markToolSuccess(sessionId, toolName);

        const duration = Date.now() - startTime;
        this.logger.info(`✅ [ToolValidator] Tool ${toolName} executed successfully in ${duration}ms`);

        return {
          success: true,
          data: result,
          attempts,
          totalDuration: duration,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        const isRetryable = this.isRetryableError(lastError);

        if (!isRetryable || i === this.retryConfig.maxRetries) {
          // No more retries or non-retryable error
          this.cacheManager.markToolFailure(sessionId, toolName, lastError.message);

          const duration = Date.now() - startTime;
          this.logger.error(
            `❌ [ToolValidator] Tool ${toolName} failed after ${attempts} attempts in ${duration}ms: ${lastError.message}`
          );

          return {
            success: false,
            error: lastError.message,
            attempts,
            totalDuration: duration,
          };
        }

        // Calculate delay for next retry with exponential backoff
        const delay = Math.min(
          this.retryConfig.initialDelay * Math.pow(this.retryConfig.backoffMultiplier, i),
          this.retryConfig.maxDelay
        );

        this.logger.warn(
          `⚠️ [ToolValidator] Tool ${toolName} failed (attempt ${attempts}), retrying in ${delay}ms: ${lastError.message}`
        );

        // Wait before retrying
        await this.sleep(delay);
      }
    }

    // Should not reach here, but handle gracefully
    const duration = Date.now() - startTime;
    return {
      success: false,
      error: lastError?.message || 'Unknown error',
      attempts,
      totalDuration: duration,
    };
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const retryablePatterns = [
      /timeout/i,
      /network/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /ENOTFOUND/i,
      /rate limit/i,
      /429/i, // Too Many Requests
      /500/i, // Internal Server Error
      /502/i, // Bad Gateway
      /503/i, // Service Unavailable
      /504/i, // Gateway Timeout
    ];

    const errorMessage = error.message.toLowerCase();
    return retryablePatterns.some(pattern => pattern.test(errorMessage));
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Validate multiple tools at once
   */
  validateMultipleTools(
    sessionId: string,
    toolNames: LlmTools[]
  ): { valid: boolean; unavailableTools: LlmTools[]; reasons: Map<LlmTools, string> } {
    const unavailableTools: LlmTools[] = [];
    const reasons = new Map<LlmTools, string>();

    for (const tool of toolNames) {
      const validation = this.validateToolAvailability(sessionId, tool);
      if (!validation.valid) {
        unavailableTools.push(tool);
        if (validation.reason) {
          reasons.set(tool, validation.reason);
        }
      }
    }

    return {
      valid: unavailableTools.length === 0,
      unavailableTools,
      reasons,
    };
  }

  /**
   * Get tool health status for debugging
   */
  getToolHealth(
    sessionId: string,
    toolName: LlmTools
  ): {
    available: boolean;
    failureCount: number;
    lastError?: string;
    lastChecked?: Date;
  } {
    const state = this.cacheManager.getToolState(sessionId, toolName);

    if (!state) {
      return {
        available: true,
        failureCount: 0,
      };
    }

    return {
      available: state.available,
      failureCount: state.failureCount,
      lastError: state.lastError,
      lastChecked: new Date(state.lastChecked),
    };
  }

  /**
   * Get health status for all tools in a session
   */
  getAllToolsHealth(sessionId: string): Map<LlmTools, ReturnType<typeof this.getToolHealth>> {
    const toolStates = this.cacheManager.getSessionToolStates(sessionId);
    const healthMap = new Map<LlmTools, ReturnType<typeof this.getToolHealth>>();

    if (!toolStates) {
      return healthMap;
    }

    for (const [tool] of toolStates) {
      healthMap.set(tool, this.getToolHealth(sessionId, tool));
    }

    return healthMap;
  }
}
