/**
 * GitHub MCP Server - Workflow Tools (GitHub Actions)
 *
 * Tools for monitoring and inspecting GitHub Actions workflow runs.
 */

import { z } from 'zod';
import * as unzipper from 'unzipper';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { ownerSchema, repoSchema, paginationParams } from '../helpers/schemas.js';
import { isRateLimitError, getErrorMessage } from '../helpers/errors.js';
import {
  TOOL_LIST_WORKFLOW_RUNS,
  TOOL_GET_WORKFLOW_RUN_DETAILS,
  TOOL_GET_WORKFLOW_RUN_LOGS,
  TOOL_GET_JOB_LOGS,
} from '../constants.js';

// Workflow run status values
const workflowStatusSchema = z
  .enum([
    'completed',
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'success',
    'timed_out',
    'in_progress',
    'queued',
    'requested',
    'waiting',
    'pending',
  ])
  .optional()
  .describe('Filter by workflow run status');

// Workflow trigger event values
// Using string instead of enum since GitHub has many event types (push, pull_request,
// workflow_dispatch, schedule, release, deployment, issues, etc.)
const workflowEventSchema = z
  .string()
  .optional()
  .describe('Filter by trigger event (e.g., push, pull_request, workflow_dispatch, schedule)');

/**
 * Summarize a failure by extracting error lines and surrounding context from log content.
 */
function summarizeFailure(logs: string, maxLines = 50): string {
  const lines = logs.split('\n');
  const errorPatterns = [
    /error:/i,
    /failed:/i,
    /FAIL /,
    /AssertionError/i,
    /TypeError:/i,
    /ReferenceError:/i,
    /SyntaxError:/i,
    /npm ERR!/,
    /pnpm ERR!/,
    /Error:/,
    /ENOENT/,
    /ETIMEDOUT/,
    /❌/,
    /✗/,
    /\[error\]/i,
  ];

  const errorLines: { lineNum: number; content: string }[] = [];

  lines.forEach((line, index) => {
    if (errorPatterns.some(pattern => pattern.test(line))) {
      errorLines.push({ lineNum: index, content: line });
    }
  });

  if (errorLines.length === 0) {
    // No errors found, return last N lines as context
    return lines.slice(-maxLines).join('\n');
  }

  // Extract context around each error (2 lines before, 5 lines after)
  const contextLines = new Set<number>();
  errorLines.forEach(({ lineNum }) => {
    for (let i = Math.max(0, lineNum - 2); i <= Math.min(lines.length - 1, lineNum + 5); i++) {
      contextLines.add(i);
    }
  });

  const sortedIndices = Array.from(contextLines).sort((a, b) => a - b);
  const result: string[] = [];
  let lastIndex = -2;

  sortedIndices.forEach(index => {
    if (index > lastIndex + 1) {
      result.push('...');
    }
    result.push(`${index + 1}: ${lines[index]}`);
    lastIndex = index;
  });

  // Truncate if too long
  if (result.length > maxLines) {
    return result.slice(0, maxLines).join('\n') + '\n... (truncated)';
  }

  return result.join('\n');
}

/**
 * Filter log content to a specific step by looking for step markers.
 * GitHub Actions logs include step headers like "##[group]Run step-name"
 */
function filterLogToStep(logs: string, stepName: string): string {
  const lines = logs.split('\n');
  const stepLines: string[] = [];
  let inStep = false;
  const stepPattern = new RegExp(`##\\[group\\].*${escapeRegex(stepName)}`, 'i');
  const endPattern = /##\[endgroup\]/;

  for (const line of lines) {
    if (stepPattern.test(line)) {
      inStep = true;
      stepLines.push(line);
    } else if (inStep) {
      if (endPattern.test(line)) {
        stepLines.push(line);
        break;
      }
      stepLines.push(line);
    }
  }

  return stepLines.length > 0 ? stepLines.join('\n') : `Step "${stepName}" not found in logs`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function registerWorkflowTools(server: McpServer) {
  // LIST WORKFLOW RUNS - View workflow runs for a repository
  server.tool(
    TOOL_LIST_WORKFLOW_RUNS,
    'List GitHub Actions workflow runs for a repository. Use this to check CI/CD status.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      branch: z.string().optional().describe('Filter by branch name'),
      status: workflowStatusSchema,
      event: workflowEventSchema,
      ...paginationParams,
    },
    async ({ owner, repo, branch, status, event, per_page, page }) => {
      try {
        const result = await octokit.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          branch,
          status,
          event,
          per_page: per_page || 10,
          page: page || 1,
        });

        return createSuccessResponse({
          total_count: result.data.total_count,
          workflow_runs: result.data.workflow_runs.map(run => ({
            id: run.id,
            name: run.name,
            head_branch: run.head_branch,
            head_sha: run.head_sha?.substring(0, 7),
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            run_number: run.run_number,
            run_started_at: run.run_started_at,
            updated_at: run.updated_at,
            url: run.html_url,
            // Include PR info if this run is from a pull request
            pull_requests: run.pull_requests?.map(pr => ({
              number: pr.number,
              url: pr.url,
            })),
          })),
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }
        console.error(`[${TOOL_LIST_WORKFLOW_RUNS}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // GET WORKFLOW RUN DETAILS - Get detailed info about a specific workflow run
  server.tool(
    TOOL_GET_WORKFLOW_RUN_DETAILS,
    'Get detailed information about a specific workflow run including jobs and steps.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      run_id: z.int().positive().describe('Workflow run ID'),
    },
    async ({ owner, repo, run_id }) => {
      try {
        // Fetch run details and jobs in parallel
        const [runResult, jobsResult] = await Promise.allSettled([
          octokit.actions.getWorkflowRun({
            owner,
            repo,
            run_id,
          }),
          octokit.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id,
            per_page: 100, // Get all jobs
          }),
        ]);

        // Run info is required - if it fails, we can't proceed
        if (runResult.status === 'rejected') {
          throw runResult.reason;
        }

        const run = runResult.value.data;

        // Jobs are optional - still return run info if jobs fetch fails
        const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value.data.jobs : [];
        const jobsError = jobsResult.status === 'rejected' ? getErrorMessage(jobsResult.reason) : null;

        return createSuccessResponse({
          workflow_run: {
            id: run.id,
            name: run.name,
            head_branch: run.head_branch,
            head_sha: run.head_sha?.substring(0, 7),
            full_sha: run.head_sha,
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            run_number: run.run_number,
            run_attempt: run.run_attempt,
            run_started_at: run.run_started_at,
            updated_at: run.updated_at,
            url: run.html_url,
            workflow_id: run.workflow_id,
            // Include commit info
            head_commit: run.head_commit
              ? {
                  message: run.head_commit.message?.split('\n')[0], // First line only
                  author: run.head_commit.author?.name,
                }
              : null,
            // Include PR info
            pull_requests: run.pull_requests?.map(pr => ({
              number: pr.number,
              url: pr.url,
            })),
          },
          jobs: jobs.map(job => ({
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            started_at: job.started_at,
            completed_at: job.completed_at,
            // Include step details
            steps: job.steps?.map(step => ({
              name: step.name,
              status: step.status,
              conclusion: step.conclusion,
              number: step.number,
              started_at: step.started_at,
              completed_at: step.completed_at,
            })),
          })),
          // Provide a summary of failed jobs/steps
          failure_summary:
            run.conclusion === 'failure'
              ? jobs
                  .filter(job => job.conclusion === 'failure')
                  .map(job => ({
                    job: job.name,
                    job_id: job.id,
                    failed_steps: job.steps?.filter(step => step.conclusion === 'failure').map(step => step.name),
                  }))
              : null,
          // Include warning if jobs fetch failed
          warning: jobsError ? `Failed to fetch jobs : ${jobsError}` : undefined,
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }
        console.error(`[${TOOL_GET_WORKFLOW_RUN_DETAILS}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // GET JOB LOGS - Get logs for a specific job
  server.tool(
    TOOL_GET_JOB_LOGS,
    'Get logs for a specific workflow job. Useful for diagnosing CI failures.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      job_id: z.int().positive().describe('Job ID (from get_workflow_run_details)'),
      step_name: z.string().optional().describe('Filter to a specific step by name'),
      tail_lines: z.number().optional().describe('Return only the last N lines (default: 100)'),
      summarize_errors: z.boolean().optional().describe('Summarize error context instead of full logs (default: true)'),
    },
    async ({ owner, repo, job_id, step_name, tail_lines, summarize_errors }) => {
      try {
        // GitHub returns a redirect URL to the logs
        const response = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id,
        });

        // response.data is the log content as a string (octokit follows redirects)
        // Handle different response types (string, ArrayBuffer, etc.)
        const rawData: unknown = response.data;
        let logContent: string;

        if (typeof rawData === 'string') {
          logContent = rawData;
        } else if (rawData instanceof ArrayBuffer) {
          logContent = new TextDecoder().decode(rawData);
        } else {
          logContent = String(rawData);
        }

        // Filter to specific step if requested
        if (step_name) {
          logContent = filterLogToStep(logContent, step_name);
        }

        // Apply tail_lines if specified
        const linesToReturn = tail_lines || 100;
        const shouldSummarize = summarize_errors !== false; // Default to true

        let processedLogs: string;
        if (shouldSummarize) {
          processedLogs = summarizeFailure(logContent, linesToReturn);
        } else {
          const lines = logContent.split('\n');
          processedLogs = lines.slice(-linesToReturn).join('\n');
        }

        return createSuccessResponse({
          job_id,
          step_filter: step_name || null,
          log_lines: processedLogs.split('\n').length,
          logs: processedLogs,
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }
        console.error(`[${TOOL_GET_JOB_LOGS}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // GET WORKFLOW RUN LOGS - Get all logs for a workflow run (downloads and extracts ZIP)
  server.tool(
    TOOL_GET_WORKFLOW_RUN_LOGS,
    'Get and summarize all logs for a workflow run. Best for "summarize the CI failure" requests.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      run_id: z.int().positive().describe('Workflow run ID'),
      max_lines: z.number().optional().describe('Maximum lines to return per job (default: 100)'),
      failed_only: z
        .boolean()
        .optional()
        .describe('Only include logs from failed jobs (default: true for failed runs)'),
    },
    async ({ owner, repo, run_id, max_lines, failed_only }) => {
      try {
        // First get run details to know the conclusion and job info
        const [runResult, jobsResult] = await Promise.allSettled([
          octokit.actions.getWorkflowRun({ owner, repo, run_id }),
          octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id, per_page: 100 }),
        ]);

        // For this tool, we need BOTH run and jobs to proceed meaningfully
        // Run is needed for conclusion, jobs are needed for log extraction
        if (runResult.status === 'rejected') {
          throw runResult.reason;
        }
        if (jobsResult.status === 'rejected') {
          throw jobsResult.reason;
        }

        const run = runResult.value.data;
        const jobs = jobsResult.value.data.jobs;

        // Determine if we should filter to failed jobs only
        const filterToFailed = failed_only ?? run.conclusion === 'failure';
        const relevantJobs = filterToFailed ? jobs.filter(j => j.conclusion === 'failure') : jobs;

        if (relevantJobs.length === 0) {
          return createSuccessResponse({
            run_id,
            run_name: run.name,
            conclusion: run.conclusion,
            message: filterToFailed
              ? 'No failed jobs found in this workflow run.'
              : 'No jobs found in this workflow run.',
            jobs_checked: jobs.length,
          });
        }

        // Download the workflow run logs (ZIP file)
        const logsResponse = await octokit.actions.downloadWorkflowRunLogs({
          owner,
          repo,
          run_id,
        });

        // The response is a redirect URL - fetch and process the ZIP
        const zipUrl = logsResponse.url;
        const zipResponse = await fetch(zipUrl);

        if (!zipResponse.ok) {
          throw new Error(`Failed to download logs: ${zipResponse.status} ${zipResponse.statusText}`);
        }

        const zipBuffer = await zipResponse.arrayBuffer();

        // Extract and process logs from ZIP
        const logsByJob: Record<string, string> = {};
        const relevantJobNames = new Set(relevantJobs.map(j => j.name));

        // Use unzipper to parse the ZIP buffer
        const directory = await unzipper.Open.buffer(Buffer.from(zipBuffer));

        for (const file of directory.files) {
          // GitHub ZIP structure: job_name/step_number_step_name.txt
          const pathParts = file.path.split('/');
          if (pathParts.length >= 1) {
            const jobName = pathParts[0];

            // Only process relevant jobs
            if (relevantJobNames.has(jobName) || !filterToFailed) {
              const content = await file.buffer();
              const logText = content.toString('utf-8');

              if (!logsByJob[jobName]) {
                logsByJob[jobName] = '';
              }
              logsByJob[jobName] += logText + '\n';
            }
          }
        }

        // Summarize each job's logs
        const linesPerJob = max_lines || 100;
        const summaries: Array<{ job: string; job_id: number | null; summary: string }> = [];

        for (const job of relevantJobs) {
          const jobLogs = logsByJob[job.name] || '';
          const summary = jobLogs ? summarizeFailure(jobLogs, linesPerJob) : 'No logs found for this job.';

          summaries.push({
            job: job.name,
            job_id: job.id,
            summary,
          });
        }

        return createSuccessResponse({
          run_id,
          run_name: run.name,
          head_branch: run.head_branch,
          head_sha: run.head_sha?.substring(0, 7),
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
          total_jobs: jobs.length,
          jobs_analyzed: summaries.length,
          filtered_to_failed: filterToFailed,
          job_logs: summaries,
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          return createErrorResponse(error, {
            suggestion: 'GitHub API rate limit exceeded. Please wait before retrying.',
          });
        }
        console.error(`[${TOOL_GET_WORKFLOW_RUN_LOGS}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );
}
