/**
 * Shared S3 security settings. Every `new sst.aws.Bucket` must pass BLOCK_ALL_PUBLIC_ACCESS as
 * `transform.publicAccessBlock` and have a matching `encryptBucketAtRest(...)` call.
 * infra/__tests__/bucketSecurity.test.ts enforces both.
 *
 * Block Public Access goes through SST's transform because SST already owns that resource; encryption
 * is a separate resource because SST has no seam for it.
 */
export const BLOCK_ALL_PUBLIC_ACCESS = {
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
} as const;

/** SSE-S3 default encryption on the bucket. */
export function encryptBucketAtRest(name: string, bucket: sst.aws.Bucket) {
  return new aws.s3.BucketServerSideEncryptionConfiguration(`${name}Encryption`, {
    bucket: bucket.name,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
  });
}

/**
 * Adds an `AWS:SourceArn` condition to the CloudFront read grant in an S3 bucket policy document, so the
 * `cloudfront.amazonaws.com` principal can read only on behalf of distributions matching `sourceArn`.
 * Throws when the policy has no such statement, so a change in SST's policy shape fails the deploy
 * instead of silently leaving the grant unscoped.
 */
export function addSourceArnToCloudfrontRead(policyJson: string, sourceArn: string): string {
  const policy = JSON.parse(policyJson) as { Statement?: unknown };
  const statements = Array.isArray(policy.Statement) ? (policy.Statement as Record<string, unknown>[]) : [];
  const asList = (v: unknown) => (Array.isArray(v) ? v : [v]);
  const cloudfrontRead = statements.filter(statement => {
    const principal = statement.Principal as { Service?: unknown } | undefined;
    return (
      statement.Effect === 'Allow' &&
      asList(principal?.Service).includes('cloudfront.amazonaws.com') &&
      asList(statement.Action).includes('s3:GetObject')
    );
  });
  if (cloudfrontRead.length === 0) throw new Error('bucket policy has no CloudFront s3:GetObject statement to scope');
  for (const statement of cloudfrontRead) {
    const condition = (statement.Condition ??= {}) as Record<string, Record<string, unknown>>;
    condition.StringLike = { ...condition.StringLike, 'AWS:SourceArn': sourceArn };
  }
  return JSON.stringify(policy);
}

export const accountDistributionsArn = (partition: string, account: string) =>
  `arn:${partition}:cloudfront::${account}:distribution/*`;

/**
 * `transform.policy` for every `access: 'cloudfront'` bucket: SST's CloudFront read grant has no
 * `AWS:SourceArn` condition, so it is limited here to distributions in this account. Not pinned to the
 * router's own distribution id: the router's origin reads the bucket through its policy resource, so a
 * policy that waits on the distribution id would be a dependency cycle.
 */
export const scopeCloudfrontRead = (args: aws.s3.BucketPolicyArgs): undefined => {
  const accountDistributions = $util
    .all([aws.getPartitionOutput().partition, aws.getCallerIdentityOutput().accountId])
    .apply(([partition, account]) => accountDistributionsArn(partition, account));
  args.policy = $util
    .all([args.policy, accountDistributions])
    .apply(([policy, sourceArn]) =>
      addSourceArnToCloudfrontRead(typeof policy === 'string' ? policy : JSON.stringify(policy), sourceArn)
    );
  return undefined;
};
