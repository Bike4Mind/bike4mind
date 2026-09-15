/**
 * GitHub Workflow Trigger Utilities
 *
 * Helper functions for triggering GitHub Actions workflows for security scans.
 */

import axios from 'axios';
import { Resource } from 'sst';
import { isPlaceholderValue, requireEnv } from '@bike4mind/common';

export interface WorkflowInputs {
  reason: string;
  stage?: string;
  target?: string;
  [key: string]: string | undefined;
}

export interface TriggerWorkflowOptions {
  workflowId: string;
  inputs: WorkflowInputs;
  repo?: string;
  ref?: string;
  token?: string;
}

/**
 * Trigger a GitHub Actions workflow via repository dispatch
 *
 * @param options - Workflow trigger options
 * @throws Error if token is not configured or if the API call fails
 *
 * @example
 * await triggerGitHubWorkflow({
 *   workflowId: 'website-owasp-zap.yml',
 *   inputs: {
 *     reason: 'scheduled-weekly',
 *     target: 'https://your-deployment.example.com',
 *     stage: 'production',
 *   },
 * });
 */
export async function triggerGitHubWorkflow(options: TriggerWorkflowOptions): Promise<void> {
  const {
    workflowId,
    inputs,
    repo = process.env.GITHUB_REPO || 'MillionOnMars/lumina5',
    ref = Resource.GITHUB_ZAP_REF?.value || process.env.GITHUB_ZAP_REF || 'main',
    token = Resource.SECOPS_ZAP_DISPATCH_TOKEN?.value || process.env.SECOPS_ZAP_DISPATCH_TOKEN,
  } = options;

  // Validate token
  if (!token || isPlaceholderValue(token)) {
    throw new Error('GitHub token for triggering workflows is not configured');
  }

  // Validate workflow ID format
  if (!workflowId.endsWith('.yml') && !workflowId.endsWith('.yaml')) {
    throw new Error('Workflow ID must be a .yml or .yaml file');
  }

  try {
    const response = await axios.post(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        ref,
        inputs,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'lumina5-security-scheduler',
        },
        timeout: 10000, // 10 second timeout
      }
    );

    // GitHub returns 204 No Content on success
    if (response.status !== 204) {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
  } catch (error) {
    // Enhance error message with context
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.message || error.message;

      throw new Error(
        `Failed to trigger GitHub workflow: ${errorMessage} (status: ${statusCode || 'unknown'}, workflow: ${workflowId}, repo: ${repo})`
      );
    }

    throw error;
  }
}

/**
 * Get the target URL for a security scan based on stage
 *
 * @param stage - The deployment stage (e.g., 'production', 'staging', 'dev')
 * @returns Target URL for the scan
 */
export function getTargetUrlForStage(stage: string): string {
  // Explicit override wins - and is the ONLY supported way to target a stage other
  // than the one this lambda is deployed to.
  if (process.env.SECURITY_DASHBOARD_WEB_URL) {
    return process.env.SECURITY_DASHBOARD_WEB_URL;
  }

  // SERVER_DOMAIN encodes ONLY this deployment's own apex - `example.com` on prod,
  // `staging.example.com` on staging, `pr<N>.preview.example.com` on a preview - injected
  // into every lambda via DEFAULT_LAMBDA_ENVIRONMENT. So `app.<SERVER_DOMAIN>` is always the
  // CURRENT stage's host, with no brand fallback. We cannot derive another
  // stage's apex from here, so cross-stage dispatch must be given explicitly via
  // SECURITY_DASHBOARD_WEB_URL. Fail loud on a cross-stage request rather than silently
  // reconstruct a wrong/doubly-prefixed host (the previous behaviour).
  const currentStage = process.env.SEED_STAGE_NAME ?? '';
  const norm = (s: string) => (s === 'staging' ? 'dev' : s); // SST stage 'dev' == staging env
  if (stage && currentStage && norm(stage) !== norm(currentStage)) {
    throw new Error(
      `getTargetUrlForStage('${stage}') called from stage '${currentStage}': a deployment can ` +
        `only resolve its own host. Set SECURITY_DASHBOARD_WEB_URL to target another stage.`
    );
  }

  return `https://app.${requireEnv('SERVER_DOMAIN', process.env.SERVER_DOMAIN)}`;
}

/**
 * Map scan type to workflow file
 *
 * @param scanType - The type of security scan
 * @returns Workflow file name
 */
export function getWorkflowIdForScanType(scanType: 'web' | 'code' | 'packages' | 'secrets' | 'cloud'): string | null {
  const workflowMap: Record<string, string> = {
    web: 'website-owasp-zap.yml',
    code: 'code-semgrep.yml',
    packages: 'packages-audit.yml',
    secrets: 'secrets-scan.yml',
    // Cloud scans run directly in Lambda, not via GitHub workflow
    cloud: '',
  };

  return workflowMap[scanType] || null;
}
