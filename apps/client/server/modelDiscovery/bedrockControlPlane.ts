import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock';
import type { modelDiscoveryService } from '@bike4mind/services';

type BedrockControlPlane = modelDiscoveryService.BedrockControlPlane;
type BedrockAvailability = modelDiscoveryService.BedrockAvailability;
type BedrockFoundationModelSummary = modelDiscoveryService.BedrockFoundationModelSummary;

/**
 * The bedrock source's injected port, implemented over the control-plane SDK.
 *
 * It lives here rather than in @bike4mind/services because
 * `@aws-sdk/client-bedrock` is a control-plane package that only this app
 * depends on; adding it to the service would put it in every consumer's
 * install. The port's shapes mirror the SDK's, so both calls are pass-throughs.
 *
 * Construct one per run, not per module: a warm Lambda can outlive its
 * credentials, and a module-scope client would sign with expired ones (the same
 * reason server/utils/cloudwatch.ts builds its client per call).
 */
export function createBedrockControlPlane(region = process.env.AWS_REGION || 'us-east-1'): BedrockControlPlane {
  const client = new BedrockClient({ region });

  return {
    async listFoundationModels(signal: AbortSignal): Promise<BedrockFoundationModelSummary[]> {
      // ListFoundationModels returns the whole catalog in one response - the API
      // has no continuation token - so a failure here is total and the source
      // reports it rather than committing a truncated list.
      const response = await client.send(new ListFoundationModelsCommand({}), { abortSignal: signal });
      return response.modelSummaries ?? [];
    },

    async getFoundationModelAvailability(modelId: string, signal: AbortSignal): Promise<BedrockAvailability | null> {
      try {
        return await client.send(new GetFoundationModelAvailabilityCommand({ modelId }), { abortSignal: signal });
      } catch {
        // "No availability data for this model this run" (sec 6.3). Never an
        // unavailable verdict: one throttled call must not disable a model.
        return null;
      }
    },
  };
}
