import { handleToolRequest } from './tools';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { registerLambdaErrorHandlers } from '@bike4mind/utils';
import { LEGACY_REQUEST_ID_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@bike4mind/common';

// Register global error handlers for network-error observability
registerLambdaErrorHandlers();

/**
 * Lambda handler wrapper for CLI tool execution.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Resolve the correlation ID once and thread it through, so the inner
  // handler's logs/error bodies and this outer fallback always report the
  // same value (a generated ID would otherwise differ between the two).
  const requestId = resolveRequestId(
    event.headers?.[REQUEST_ID_HEADER.toLowerCase()],
    event.headers?.[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
  );
  try {
    return await handleToolRequest(event, requestId);
  } catch (error) {
    console.error('[CLI_TOOLS] Handler error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        request_id: requestId,
      }),
    };
  }
};
