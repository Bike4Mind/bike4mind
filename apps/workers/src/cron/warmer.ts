import { Handler } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface WarmerEvent {
  source?: string;
  warmer?: boolean;
  concurrency?: number;
}

/**
 * Lambda warmer handler that keeps target functions warm by invoking them periodically
 */
export const dispatch: Handler<WarmerEvent> = async (event, context) => {
  const lambda = new LambdaClient({});
  const targetFunctionName = process.env.TARGET_FUNCTION_NAME;
  const targetHandlerPath = process.env.TARGET_HANDLER_PATH;
  const concurrency = parseInt(process.env.WARMER_CONCURRENCY || '1', 10);
  const warmerName = process.env.WARMER_NAME || 'unknown';

  // Support both direct function names and handler paths
  let functionToInvoke: string;
  if (targetFunctionName) {
    functionToInvoke = targetFunctionName;
  } else if (targetHandlerPath) {
    // Derive the function name from the handler path; SST v3 names functions {app}-{stage}-{handler-name}
    const handlerName = targetHandlerPath.split('/').pop()?.replace('.dispatch', '').replace('.handler', '');
    functionToInvoke = `${context.functionName.split('-').slice(0, 2).join('-')}-${handlerName}`;
  } else {
    console.error('Either TARGET_FUNCTION_NAME or TARGET_HANDLER_PATH environment variable is required');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'No target function configured' }),
    };
  }

  console.log(
    `Warmer ${warmerName}: Starting warm-up for function ${functionToInvoke} with concurrency ${concurrency}`
  );

  try {
    const warmingPayload = {
      source: 'warmer',
      warmer: true,
      warmerName,
      timestamp: new Date().toISOString(),
    };

    // Create concurrent invocations to keep multiple instances warm
    const invocations = Array.from({ length: concurrency }, async (_, index) => {
      const payload = {
        ...warmingPayload,
        warmerIndex: index,
      };

      try {
        const command = new InvokeCommand({
          FunctionName: functionToInvoke,
          InvocationType: 'Event', // Async invocation
          Payload: JSON.stringify(payload),
        });

        const response = await lambda.send(command);

        console.log(`Warmer ${warmerName}: Invocation ${index + 1}/${concurrency} completed`, {
          statusCode: response.StatusCode,
          functionName: functionToInvoke,
        });

        return { success: true, index, statusCode: response.StatusCode };
      } catch (error) {
        console.error(`Warmer ${warmerName}: Invocation ${index + 1}/${concurrency} failed`, {
          error: error instanceof Error ? error.message : String(error),
          functionName: functionToInvoke,
        });

        return { success: false, index, error: error instanceof Error ? error.message : String(error) };
      }
    });

    const results = await Promise.all(invocations);

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`Warmer ${warmerName}: Completed warming cycle`, {
      targetFunction: functionToInvoke,
      concurrency,
      successful,
      failed,
      totalInvocations: results.length,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Warmer completed for ${functionToInvoke}`,
        warmerName,
        concurrency,
        successful,
        failed,
        results,
      }),
    };
  } catch (error) {
    console.error(`Warmer ${warmerName}: Critical error during warming cycle`, {
      error: error instanceof Error ? error.message : String(error),
      targetFunction: functionToInvoke,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Warmer execution failed',
        warmerName,
        targetFunction: functionToInvoke,
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};
