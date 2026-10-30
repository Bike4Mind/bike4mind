/**
 * Where a provider's workload identity federation gets its subject JWT, chosen by
 * PROVIDER_WIF_TOKEN_SOURCE: `github-actions` (default, CI jobs with `id-token: write`) or
 * `aws-sts` (STS GetWebIdentityToken under the running IAM role, e.g. a Lambda).
 */
export type WifTokenSourceName = 'github-actions' | 'aws-sts';

export type SubjectTokenSource = (audience: string) => Promise<string>;

export function selectedWifTokenSource(): WifTokenSourceName {
  const raw = process.env.PROVIDER_WIF_TOKEN_SOURCE?.trim();
  if (!raw || raw === 'github-actions') return 'github-actions';
  if (raw === 'aws-sts') return 'aws-sts';
  throw new Error(`Unknown PROVIDER_WIF_TOKEN_SOURCE "${raw}"; expected github-actions or aws-sts`);
}

/** A fresh GitHub Actions identity token for `audience`; the SDK calls this again on each exchange. */
export async function githubActionsIdToken(audience: string): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    throw new Error('ACTIONS_ID_TOKEN_REQUEST_URL is not set; the job needs `id-token: write` permission');
  }
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!res.ok) throw new Error(`GitHub identity token request failed with status ${res.status}`);
  const body = (await res.json()) as { value?: string };
  if (!body.value) throw new Error('GitHub identity token response had no value');
  return body.value;
}

type StsModule = typeof import('@aws-sdk/client-sts');

// Loaded on first use so consumers that never federate through STS skip its bundle and cold-start cost.
let stsModule: Promise<StsModule> | undefined;
let stsClient: InstanceType<StsModule['STSClient']> | undefined;

/**
 * A fresh STS-signed JWT for `audience`. GetWebIdentityToken is not served by the global STS
 * endpoint, so the client relies on AWS_REGION (always set on Lambda) to pick a regional one.
 */
export async function awsStsIdToken(audience: string): Promise<string> {
  stsModule ??= import('@aws-sdk/client-sts').catch(err => {
    stsModule = undefined;
    throw err;
  });
  const { STSClient, GetWebIdentityTokenCommand } = await stsModule;
  stsClient ??= new STSClient({});
  const out = await stsClient.send(new GetWebIdentityTokenCommand({ Audience: [audience], SigningAlgorithm: 'RS256' }));
  if (!out.WebIdentityToken) throw new Error('STS GetWebIdentityToken returned no token');
  return out.WebIdentityToken;
}

export function subjectTokenSource(name: WifTokenSourceName = selectedWifTokenSource()): SubjectTokenSource {
  return name === 'aws-sts' ? awsStsIdToken : githubActionsIdToken;
}
