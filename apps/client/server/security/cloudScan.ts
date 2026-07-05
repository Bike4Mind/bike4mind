import {
  connectDB,
  securityDashboardSnapshotRepository,
  type ISecurityDashboardSnapshotDocument,
} from '@bike4mind/database';
import {
  IAMClient,
  GetAccountSummaryCommand,
  GenerateCredentialReportCommand,
  GetCredentialReportCommand,
  ListPoliciesCommand,
  GetPolicyVersionCommand,
} from '@aws-sdk/client-iam';
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import {
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import { EC2Client, DescribeSecurityGroupsCommand, type SecurityGroup } from '@aws-sdk/client-ec2';
import { resolveStage } from './resolveStage';
import { computeStatusScoreAndSummary } from './securityDashboardScoring';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

type CloudSeverity = 'critical' | 'high' | 'medium' | 'low';

interface CloudRuleResult {
  id: string;
  title: string;
  severity: CloudSeverity;
  passed: boolean;
  description: string;
  recommendation?: string;
  documentationUrl?: string;
}

const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

async function evaluateIamRootMfa(): Promise<CloudRuleResult> {
  const client = new IAMClient({ region: AWS_REGION });

  try {
    const result = await client.send(new GetAccountSummaryCommand({}));
    const mfaEnabled = (result.SummaryMap?.AccountMFAEnabled ?? 0) > 0;

    return {
      id: 'iam-root-mfa-enabled',
      title: 'Root account has MFA enabled',
      severity: 'critical',
      passed: mfaEnabled,
      description: mfaEnabled
        ? 'AWS account root user has multi-factor authentication enabled.'
        : 'AWS account root user does not have multi-factor authentication (MFA) enabled.',
      recommendation: mfaEnabled
        ? undefined
        : 'Enable MFA on the AWS account root user to reduce the risk of account takeover.',
      documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html#id_root-user_manage_mfa',
    };
  } catch (error) {
    // If we cannot evaluate the rule (eg. missing permissions), surface a low-severity finding
    return {
      id: 'iam-root-mfa-evaluation-error',
      title: 'Unable to verify root account MFA status',
      severity: 'low',
      passed: false,
      description:
        'The Cloud Security scan could not verify whether the AWS account root user has MFA enabled due to missing permissions or an API error.',
      recommendation:
        'Ensure the Cloud Security scan Lambda has iam:GetAccountSummary permission, or manually verify root MFA status in the AWS console.',
      documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_enable_virtual.html',
    };
  }
}

async function evaluateS3BucketBaselines(): Promise<CloudRuleResult[]> {
  const client = new S3Client({ region: AWS_REGION });
  const results: CloudRuleResult[] = [];

  try {
    const list = await client.send(new ListBucketsCommand({}));
    const buckets = list.Buckets ?? [];

    for (const bucket of buckets) {
      if (!bucket.Name) continue;

      const bucketName = bucket.Name;

      try {
        // Check for public access block configuration
        let hasPublicAccessBlock = false;
        try {
          const pab = await client.send(
            new GetPublicAccessBlockCommand({
              Bucket: bucketName,
            })
          );
          const cfg = pab.PublicAccessBlockConfiguration;
          hasPublicAccessBlock = Boolean(
            cfg && cfg.BlockPublicAcls && cfg.BlockPublicPolicy && cfg.IgnorePublicAcls && cfg.RestrictPublicBuckets
          );
        } catch {
          // If the call fails (eg. no config), treat as not having a full public access block
          hasPublicAccessBlock = false;
        }

        results.push({
          id: `s3-public-access-block-${bucketName}`,
          title: `S3 bucket has public access block enabled`,
          severity: 'high',
          passed: hasPublicAccessBlock,
          description: hasPublicAccessBlock
            ? `S3 bucket "${bucketName}" has Block Public Access fully enabled.`
            : `S3 bucket "${bucketName}" does not have all Block Public Access settings enabled.`,
          recommendation: hasPublicAccessBlock
            ? undefined
            : `Enable "Block Public Access" on S3 bucket "${bucketName}" to prevent accidental public exposure of data.`,
          documentationUrl:
            'https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html',
        });

        // Check for default encryption at rest
        let hasEncryption = false;
        try {
          const enc = await client.send(
            new GetBucketEncryptionCommand({
              Bucket: bucketName,
            })
          );
          hasEncryption = Boolean(enc.ServerSideEncryptionConfiguration?.Rules?.length);
        } catch {
          hasEncryption = false;
        }

        results.push({
          id: `s3-default-encryption-${bucketName}`,
          title: `S3 bucket has default encryption enabled`,
          severity: 'medium',
          passed: hasEncryption,
          description: hasEncryption
            ? `S3 bucket "${bucketName}" has default server-side encryption configured.`
            : `S3 bucket "${bucketName}" does not have default server-side encryption configured.`,
          recommendation: hasEncryption
            ? undefined
            : `Enable default server-side encryption (SSE-S3 or SSE-KMS) on S3 bucket "${bucketName}" to protect data at rest.`,
          documentationUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-encryption.html',
        });
      } catch (bucketError) {
        // If evaluating a specific bucket fails unexpectedly, record a low-severity finding
        // but continue processing the remaining buckets.
        results.push({
          id: `s3-bucket-evaluation-error-${bucketName}`,
          title: `Unable to evaluate bucket: ${bucketName}`,
          severity: 'low',
          passed: false,
          description:
            `Error while evaluating baseline controls for S3 bucket "${bucketName}".` +
            (bucketError instanceof Error ? ` Reason: ${bucketError.message}.` : ''),
          recommendation:
            'Ensure the Cloud Security scan Lambda has permissions to read public access block and encryption configuration for this bucket, or review this bucket manually.',
          documentationUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html',
        });
        continue;
      }
    }
  } catch (error) {
    results.push({
      id: 's3-bucket-baseline-evaluation-error',
      title: 'Unable to evaluate S3 bucket baseline controls',
      severity: 'low',
      passed: false,
      description:
        'The Cloud Security scan could not enumerate S3 buckets or their configurations due to missing permissions or an API error.',
      recommendation:
        'Ensure the Cloud Security scan Lambda has s3:ListBuckets, s3:GetPublicAccessBlock, and s3:GetBucketEncryption permissions, or manually review S3 security baselines.',
      documentationUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html',
    });
  }

  return results;
}

async function evaluateCloudTrailEnabled(): Promise<CloudRuleResult> {
  const client = new CloudTrailClient({ region: AWS_REGION });
  try {
    const { trailList = [] } = await client.send(new DescribeTrailsCommand({ includeShadowTrails: false }));
    const multiRegionTrails = trailList.filter(t => t.IsMultiRegionTrail);
    if (multiRegionTrails.length === 0) {
      return {
        id: 'cloudtrail-multi-region-enabled',
        title: 'CloudTrail multi-region logging enabled',
        severity: 'critical',
        passed: false,
        description: 'No multi-region CloudTrail trail found. Management events in other regions are not logged.',
        recommendation: 'Create a multi-region trail with management event logging enabled.',
        documentationUrl:
          'https://docs.aws.amazon.com/awscloudtrail/latest/userguide/receive-cloudtrail-log-files-from-multiple-regions.html',
      };
    }
    for (const trail of multiRegionTrails) {
      if (!trail.TrailARN) continue;
      const status = await client.send(new GetTrailStatusCommand({ Name: trail.TrailARN }));
      if (status.IsLogging) {
        return {
          id: 'cloudtrail-multi-region-enabled',
          title: 'CloudTrail multi-region logging enabled',
          severity: 'critical',
          passed: true,
          description: 'A multi-region CloudTrail trail is active and logging.',
        };
      }
    }
    return {
      id: 'cloudtrail-multi-region-enabled',
      title: 'CloudTrail multi-region logging enabled',
      severity: 'critical',
      passed: false,
      description: 'Multi-region CloudTrail trail exists but logging is not active.',
      recommendation: 'Enable logging on the multi-region CloudTrail trail.',
    };
  } catch {
    return {
      id: 'cloudtrail-evaluation-error',
      title: 'Unable to verify CloudTrail status',
      severity: 'low',
      passed: false,
      description: 'Cloud scan could not check CloudTrail due to missing permissions or API error.',
      recommendation: 'Ensure Lambda has cloudtrail:DescribeTrails and cloudtrail:GetTrailStatus permissions.',
    };
  }
}

async function evaluateOpenSecurityGroups(): Promise<CloudRuleResult[]> {
  const client = new EC2Client({ region: AWS_REGION });
  const results: CloudRuleResult[] = [];
  try {
    // Paginate through all security groups - AWS returns max 1000 per call.
    const SecurityGroups: SecurityGroup[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }));
      SecurityGroups.push(...(resp.SecurityGroups ?? []));
      nextToken = resp.NextToken;
    } while (nextToken);
    const SENSITIVE_PORTS = [22, 3389]; // SSH, RDP
    for (const sg of SecurityGroups) {
      for (const rule of sg.IpPermissions ?? []) {
        const fromPort = rule.FromPort ?? 0;
        const toPort = rule.ToPort ?? 65535;
        const isOpenToWorld =
          (rule.IpRanges ?? []).some(r => r.CidrIp === '0.0.0.0/0') ||
          (rule.Ipv6Ranges ?? []).some(r => r.CidrIpv6 === '::/0');
        const exposedPorts = SENSITIVE_PORTS.filter(p => p >= fromPort && p <= toPort);
        if (isOpenToWorld && exposedPorts.length > 0) {
          results.push({
            id: `sg-open-${sg.GroupId}-port-${exposedPorts.join('-')}`,
            title: `Security group allows unrestricted ${exposedPorts.includes(22) ? 'SSH' : 'RDP'} access`,
            severity: 'high',
            passed: false,
            description: `Security group "${sg.GroupName}" (${sg.GroupId}) allows inbound traffic on port(s) ${exposedPorts.join(', ')} from 0.0.0.0/0.`,
            recommendation: `Restrict inbound port ${exposedPorts.join('/')} access to known CIDR ranges. Remove 0.0.0.0/0 ingress rules.`,
            documentationUrl: 'https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html',
          });
        }
      }
    }
    if (results.length === 0) {
      results.push({
        id: 'sg-open-sensitive-ports',
        title: 'No security groups with open SSH/RDP',
        severity: 'high',
        passed: true,
        description: 'No security groups expose SSH (22) or RDP (3389) to 0.0.0.0/0.',
      });
    }
  } catch {
    results.push({
      id: 'sg-evaluation-error',
      title: 'Unable to evaluate security groups',
      severity: 'low',
      passed: false,
      description: 'Cloud scan could not check security groups due to missing permissions or API error.',
      recommendation: 'Ensure Lambda has ec2:DescribeSecurityGroups permission.',
    });
  }
  return results;
}

async function evaluateIamUsersWithoutMfa(): Promise<CloudRuleResult> {
  const iamClient = new IAMClient({ region: AWS_REGION });
  try {
    await iamClient.send(new GenerateCredentialReportCommand({}));
    // Poll up to 10 times with 3s intervals (30s budget). AWS docs state generation
    // typically completes within 30s for accounts with hundreds of users.
    let reportContent: string | undefined;
    for (let i = 0; i < 10; i++) {
      try {
        const report = await iamClient.send(new GetCredentialReportCommand({}));
        reportContent = report.Content ? Buffer.from(report.Content).toString('utf-8') : undefined;
        if (reportContent) break;
      } catch {
        /* report not ready yet */
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!reportContent) {
      return {
        id: 'iam-users-without-mfa-evaluation-error',
        title: 'IAM users with active keys but no MFA',
        severity: 'low',
        passed: false,
        description: 'Credential report not ready in time.',
        recommendation: 'Re-run the cloud scan.',
      };
    }
    const lines = reportContent.trim().split('\n');
    // AWS credential report CSV fields never contain commas - safe to split naively.
    // See: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_getting-report.html
    const headers = lines[0].split(',');
    const col = (name: string) => headers.indexOf(name);
    const offenders: string[] = [];
    for (const line of lines.slice(1)) {
      const fields = line.split(',');
      const user = fields[col('user')];
      const mfaActive = fields[col('mfa_active')] === 'true';
      const key1Active = fields[col('access_key_1_active')] === 'true';
      const key2Active = fields[col('access_key_2_active')] === 'true';
      if ((key1Active || key2Active) && !mfaActive && user !== '<root_account>') {
        offenders.push(user);
      }
    }
    const passed = offenders.length === 0;
    return {
      id: 'iam-users-active-keys-no-mfa',
      title: 'IAM users with active access keys have MFA enabled',
      severity: 'high',
      passed,
      description: passed
        ? 'All IAM users with active access keys have MFA enabled.'
        : `${offenders.length} IAM user(s) have active access keys without MFA: ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ` and ${offenders.length - 5} more` : ''}.`,
      recommendation: passed ? undefined : 'Enable MFA for all IAM users that have programmatic access keys.',
      documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa.html',
    };
  } catch {
    return {
      id: 'iam-users-mfa-evaluation-error',
      title: 'Unable to verify IAM user MFA status',
      severity: 'low',
      passed: false,
      description: 'Cloud scan could not check IAM credential report.',
      recommendation: 'Ensure Lambda has iam:GenerateCredentialReport and iam:GetCredentialReport permissions.',
    };
  }
}

async function evaluateIamWildcardPolicies(): Promise<CloudRuleResult> {
  const iamClient = new IAMClient({ region: AWS_REGION });
  try {
    // Paginate through all customer-managed policies - AWS returns max 100 per call.
    const Policies: Array<{ Arn?: string; DefaultVersionId?: string; PolicyName?: string }> = [];
    let marker: string | undefined;
    do {
      const resp = await iamClient.send(new ListPoliciesCommand({ Scope: 'Local', Marker: marker }));
      Policies.push(...(resp.Policies ?? []));
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
    const wildcardPolicies: string[] = [];
    // Fetch policy documents in batches of 20 to avoid serial per-policy latency
    // while staying within IAM API rate limits.
    const BATCH_SIZE = 20;
    for (let i = 0; i < Policies.length; i += BATCH_SIZE) {
      const batch = Policies.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async policy => {
          if (!policy.Arn || !policy.DefaultVersionId) return null;
          const { PolicyVersion } = await iamClient.send(
            new GetPolicyVersionCommand({ PolicyArn: policy.Arn, VersionId: policy.DefaultVersionId })
          );
          const doc = JSON.parse(decodeURIComponent(PolicyVersion?.Document ?? '{}')) as {
            Statement?: Array<{ Effect: string; Action: unknown; Resource: unknown }>;
          };
          const statements: Array<{ Effect: string; Action: unknown; Resource: unknown }> = Array.isArray(doc.Statement)
            ? doc.Statement
            : doc.Statement
              ? [doc.Statement]
              : [];
          const hasWildcard = statements.some(
            s =>
              s.Effect === 'Allow' &&
              (s.Action === '*' || (Array.isArray(s.Action) && (s.Action as string[]).includes('*'))) &&
              (s.Resource === '*' || (Array.isArray(s.Resource) && (s.Resource as string[]).includes('*')))
          );
          return hasWildcard ? (policy.PolicyName ?? policy.Arn) : null;
        })
      );
      for (const name of batchResults) {
        if (name) wildcardPolicies.push(name);
      }
    }
    const passed = wildcardPolicies.length === 0;
    return {
      id: 'iam-no-wildcard-policies',
      title: 'No customer-managed IAM policies grant Action:* Resource:*',
      severity: 'critical',
      passed,
      description: passed
        ? 'No customer-managed IAM policies grant unrestricted wildcard access.'
        : `${wildcardPolicies.length} policy(ies) grant Action:* Resource:*: ${wildcardPolicies.slice(0, 3).join(', ')}${wildcardPolicies.length > 3 ? '...' : ''}.`,
      recommendation: passed
        ? undefined
        : 'Replace wildcard policies with least-privilege policies scoped to specific actions and resources.',
      documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege',
    };
  } catch {
    return {
      id: 'iam-wildcard-policy-evaluation-error',
      title: 'Unable to verify IAM wildcard policies',
      severity: 'low',
      passed: false,
      description: 'Cloud scan could not enumerate IAM policies.',
      recommendation: 'Ensure Lambda has iam:ListPolicies and iam:GetPolicyVersion permissions.',
    };
  }
}

async function evaluateSecretsManagerRotation(): Promise<CloudRuleResult> {
  const smClient = new SecretsManagerClient({ region: AWS_REGION });
  try {
    // Paginate through all secrets - AWS returns max 100 per call.
    const SecretList: Array<{ Name?: string; ARN?: string; RotationEnabled?: boolean }> = [];
    let nextToken: string | undefined;
    do {
      const resp = await smClient.send(new ListSecretsCommand({ NextToken: nextToken }));
      SecretList.push(...(resp.SecretList ?? []));
      nextToken = resp.NextToken;
    } while (nextToken);
    const noRotation = SecretList.filter(s => !s.RotationEnabled).map(s => s.Name ?? s.ARN ?? 'unknown');
    const passed = noRotation.length === 0;
    return {
      id: 'secretsmanager-rotation-enabled',
      title: 'All Secrets Manager secrets have rotation enabled',
      severity: 'medium',
      passed,
      description: passed
        ? 'All Secrets Manager secrets have automatic rotation configured.'
        : `${noRotation.length} secret(s) do not have automatic rotation: ${noRotation.slice(0, 3).join(', ')}${noRotation.length > 3 ? '...' : ''}.`,
      recommendation: passed ? undefined : 'Enable automatic rotation for all Secrets Manager secrets where possible.',
      documentationUrl: 'https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html',
    };
  } catch {
    return {
      id: 'secretsmanager-rotation-evaluation-error',
      title: 'Unable to verify Secrets Manager rotation',
      severity: 'low',
      passed: false,
      description: 'Cloud scan could not list Secrets Manager secrets.',
      recommendation: 'Ensure Lambda has secretsmanager:ListSecrets permission.',
    };
  }
}

export const handler = async (): Promise<void> => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  try {
    const stage = resolveStage();

    // Evaluate individual rule families in parallel where possible.
    const [iamRootMfaRule, s3Rules, cloudTrailRule, sgRules, iamUsersRule, iamWildcardRule, smRotationRule] =
      await Promise.all([
        evaluateIamRootMfa(),
        evaluateS3BucketBaselines(),
        evaluateCloudTrailEnabled(),
        evaluateOpenSecurityGroups(),
        evaluateIamUsersWithoutMfa(),
        evaluateIamWildcardPolicies(),
        evaluateSecretsManagerRotation(),
      ]);

    const allRules: CloudRuleResult[] = [
      iamRootMfaRule,
      ...s3Rules,
      cloudTrailRule,
      ...sgRules,
      iamUsersRule,
      iamWildcardRule,
      smRotationRule,
    ];

    const failedRules = allRules.filter(rule => !rule.passed);

    const counts = failedRules.reduce(
      (acc, rule) => {
        if (rule.severity === 'critical') acc.critical += 1;
        else if (rule.severity === 'high') acc.high += 1;
        else if (rule.severity === 'medium') acc.medium += 1;
        else acc.low += 1;
        return acc;
      },
      { critical: 0, high: 0, medium: 0, low: 0 }
    );

    const { status, score, summary } = computeStatusScoreAndSummary(counts, 'cloud configuration issues', {
      noneDetectedSentence: 'No cloud misconfigurations detected in the latest scan.',
    });

    const findings: ISecurityDashboardSnapshotDocument['findings'] = failedRules.map(rule => {
      return {
        id: rule.id,
        title: rule.title,
        severity: rule.severity,
        description: rule.description,
        recommendation: rule.recommendation,
        documentationUrl: rule.documentationUrl,
      };
    });

    const checkedAt = new Date();

    const snapshotInput: Omit<ISecurityDashboardSnapshotDocument, 'id' | 'createdAt' | 'updatedAt'> = {
      stage,
      scanType: 'cloud',
      targetUrl: `aws:${AWS_REGION}`,
      status,
      score,
      summary,
      findings,
      checkedAt,
    };

    await securityDashboardSnapshotRepository.create(snapshotInput);
  } catch (error) {
    console.error('Cloud security scan failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
};
