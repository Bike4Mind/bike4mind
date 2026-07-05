#!/usr/bin/env node
/**
 * Create a production release with AI-generated changelog
 *
 * This script:
 * 1. Fetches commits since last release
 * 2. Generates changelog using AI (Bedrock)
 * 3. Creates GitHub Release with CalVer tag
 * 4. Sends Slack notification
 *
 * Usage:
 *   # Using environment variables
 *   pnpm sst shell pnpm --filter @bike4mind/scripts create-prod-release --dry-run
 *
 *   # Using CLI flags
 *   pnpm sst shell pnpm --filter @bike4mind/scripts create-prod-release \
 *     --dry-run \
 *     --repo MillionOnMars/lumina5 \
 *     --github-token ghp_xxx \
 *     --slack https://hooks.slack.com/...
 *
 * Environment variables (can be overridden by CLI flags):
 * - GITHUB_TOKEN: GitHub API token
 * - GITHUB_REPOSITORY: Repository in format owner/repo
 * - SLACK_WEBHOOK_URL: Slack webhook URL (optional)
 * - AWS credentials (provided by SST shell)
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  getLatestRelease,
  getCommitsSinceLastRelease,
  createRelease,
  getCurrentPRNumber,
  getRepoUrl,
} from './utils/githubApi';
import { getNextVersion, getDailyDeploymentNumber } from './utils/versioningUtils';
import { generateChangelog, formatChangelogMarkdown } from './generateChangelog';
import { formatSlackMessage, sendSlackNotification } from './utils/slackFormatter';

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const required = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }

  // Slack webhook is optional but warn if missing
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.warn('⚠️  SLACK_WEBHOOK_URL not set - skipping Slack notification');
  }
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  // Parse CLI arguments with yargs
  const argv = await yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .option('dry-run', {
      alias: 'd',
      type: 'boolean',
      description: 'Preview the release without creating it',
      default: false,
    })
    .option('target-branch', {
      alias: 'branch',
      type: 'string',
      description: 'Target branch to compare against (defaults to "prod", use "HEAD" for testing)',
      default: 'prod',
    })
    .option('github-token', {
      type: 'string',
      description: 'GitHub API token (or use GITHUB_TOKEN env var)',
    })
    .option('github-repository', {
      alias: 'repo',
      type: 'string',
      description: 'Repository in format owner/repo (or use GITHUB_REPOSITORY env var)',
    })
    .option('slack-webhook-url', {
      alias: 'slack',
      type: 'string',
      description: 'Slack webhook URL (or use SLACK_WEBHOOK_URL env var)',
    })
    .option('send-slack-notification', {
      type: 'boolean',
      description: 'Force enable/disable Slack notification (overrides default behavior)',
    })
    .example('$0 --dry-run', 'Preview release using environment variables')
    .example('$0 --dry-run --target-branch HEAD', 'Test from current branch')
    .example('$0 --dry-run --repo MillionOnMars/lumina5 --github-token ghp_xxx', 'Preview with explicit credentials')
    .example('$0 --help', 'Show help')
    .help()
    .alias('help', 'h')
    .parse();

  // Override environment variables with CLI arguments if provided
  if (argv['github-token']) {
    process.env.GITHUB_TOKEN = argv['github-token'];
  }
  if (argv['github-repository']) {
    process.env.GITHUB_REPOSITORY = argv['github-repository'];
  }
  if (argv['slack-webhook-url']) {
    process.env.SLACK_WEBHOOK_URL = argv['slack-webhook-url'];
  }
  if (typeof argv['send-slack-notification'] !== 'undefined') {
    process.env.SEND_SLACK_NOTIFICATION = argv['send-slack-notification'] ? 'true' : 'false';
  }

  // Check for dry run mode from CLI args or environment variable
  const isDryRun = argv['dry-run'] || process.env.DRY_RUN === 'true';

  if (isDryRun) {
    console.log('🧪 DRY RUN MODE - No actual releases will be created\n');
  } else {
    console.log('🚀 Creating production release...\n');
  }

  // Validate environment
  validateEnvironment();

  try {
    // Step 1: Get latest release and calculate next version
    console.log('📦 Fetching latest release...');
    const latestRelease = await getLatestRelease(/^v\d+\.\d+\.\d+\.\d+$/);
    const latestTag = latestRelease?.tag_name || null;

    if (latestTag) {
      console.log(`   Latest release: ${latestTag}`);
    } else {
      console.log('   No previous releases found - this is the first one!');
    }

    const nextVersion = getNextVersion(latestTag);
    const deployNumber = getDailyDeploymentNumber(latestTag);

    console.log(`   Next version: ${nextVersion}`);
    if (deployNumber > 1) {
      console.log(`   Deploy #${deployNumber} today\n`);
    } else {
      console.log('');
    }

    // Step 2: Get commits since last release
    const targetBranch = argv['target-branch'] as string;
    console.log(`📝 Fetching commits since last release (comparing to ${targetBranch})...`);
    const commits = await getCommitsSinceLastRelease(targetBranch);

    if (commits.length === 0) {
      console.log('⚠️  No commits found since last release - skipping release');
      return;
    }

    console.log(`   Found ${commits.length} commits\n`);

    // Step 3: Generate changelog using AI
    const prNumber = getCurrentPRNumber();
    if (prNumber) {
      console.log(`   PR #${prNumber}\n`);
    }

    const changelog = await generateChangelog(commits, {
      prNumber,
      deployNumber,
    });

    console.log(`   Title: ${changelog.title}\n`);

    // Step 4: Create GitHub Release
    const releaseBody = formatChangelogMarkdown(changelog);
    const releaseName = `${nextVersion} - ${changelog.title}`;

    let releaseUrl = '';

    if (isDryRun) {
      console.log('📦 Would create GitHub Release:');
      console.log(`   Tag: ${nextVersion}`);
      console.log(`   Name: ${releaseName}`);
      console.log(`   Body:\n${releaseBody}\n`);
      releaseUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/${nextVersion}`;
    } else {
      console.log('📦 Creating GitHub Release...');
      const release = await createRelease({
        tag: nextVersion,
        name: releaseName,
        body: releaseBody,
        targetCommitish: 'prod',
      });
      releaseUrl = release.html_url;
      console.log(`   ✅ Release created: ${releaseUrl}\n`);
    }

    // Step 5: Send Slack notification
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    const shouldSendSlack =
      process.env.SEND_SLACK_NOTIFICATION === 'true' ||
      (typeof process.env.SEND_SLACK_NOTIFICATION === 'undefined' && !!webhookUrl);

    if (shouldSendSlack && webhookUrl) {
      const repoUrl = getRepoUrl();
      const appName = process.env.SEED_APP_NAME;
      const slackMessage = formatSlackMessage(changelog, nextVersion, releaseUrl, repoUrl, appName);
      console.log(`Slack webhook URL:`, webhookUrl);

      if (isDryRun && process.env.SEND_SLACK_NOTIFICATION !== 'true') {
        console.log('💬 Would send Slack notification:');
        console.log(JSON.stringify(slackMessage, null, 2));
        console.log('');
      } else {
        // If SEND_SLACK_NOTIFICATION === 'true', send even in dry run
        console.log('💬 Sending Slack notification...');
        await sendSlackNotification(slackMessage, webhookUrl);
        console.log('');
      }
    }

    // Success summary
    if (isDryRun) {
      console.log('✅ Dry run complete!');
      console.log(`   Would have created version: ${nextVersion}`);
      console.log(`   Would have released at: ${releaseUrl}`);
    } else {
      console.log('✅ Production release complete!');
      console.log(`   Version: ${nextVersion}`);
      console.log(`   Release: ${releaseUrl}`);
    }
    if (deployNumber > 1) {
      console.log(`   Deploy #${deployNumber} today`);
    }
  } catch (error) {
    console.error('\n❌ Failed to create production release:', error);
    if (error instanceof Error) {
      console.error(error.message);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}

main()
  .then(() => {
    // Explicitly exit to close any open handles (AWS SDK, HTTP clients, etc.)
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Unhandled error:', error);
    process.exit(1);
  });
