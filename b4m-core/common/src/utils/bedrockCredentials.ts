import { isPlaceholderApiKey } from '../types/entities/SystemSecretsTypes';

export interface BedrockStaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const usable = (value: string | undefined): string | undefined =>
  isPlaceholderApiKey(value) ? undefined : value?.trim();

/**
 * The credential part of a Bedrock SDK client config, or null when Bedrock is unreachable.
 *
 * Hosted returns `{}`: the default chain (task/Lambda role) signs, as it always has. Self-host
 * returns explicit BEDROCK_AWS_* credentials, or null without them - there the plain AWS_* pair
 * is the local MinIO credential and must never be sent to Bedrock, which also rules out the
 * default chain (it would pick that pair up first). Every Bedrock gate (model discovery, the
 * picker in llm-adapters' backendGate, the runtime client) reads this, so they cannot disagree.
 */
export function bedrockClientCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env
): { credentials?: BedrockStaticCredentials } | null {
  if (env.B4M_SELF_HOST !== 'true') return {};
  const accessKeyId = usable(env.BEDROCK_AWS_ACCESS_KEY_ID);
  const secretAccessKey = usable(env.BEDROCK_AWS_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = usable(env.BEDROCK_AWS_SESSION_TOKEN);
  return { credentials: { accessKeyId, secretAccessKey, ...(sessionToken && { sessionToken }) } };
}
