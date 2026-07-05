/**
 * AI-powered changelog generation using AWS Bedrock
 */

import { AnthropicBedrockBackend } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';
import { getPRWithCommits } from './utils/githubApi';

interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface ChangelogSection {
  type: 'features' | 'fixes' | 'performance' | 'internal' | 'hotfix';
  items: string[];
}

interface Changelog {
  title: string;
  sections: ChangelogSection[];
  briefSummary: string[];
  metadata: {
    commitCount: number;
    prNumber: number | null;
    prNumbers: number[]; // All PR numbers included in this release
    deployedAt: string;
    deployNumber: number;
  };
}

interface ParsedCommit {
  type: string;
  scope?: string;
  subject: string;
  isBreaking: boolean;
  rawMessage: string;
}

interface PRGroup {
  prNumber: number;
  prTitle: string;
  commits: GitHubCommit[];
}

interface CommitGroups {
  prGroups: PRGroup[];
  standaloneCommits: GitHubCommit[];
}

/**
 * Parse conventional commit format
 * Examples:
 *   feat(client): add user auth modal
 *   fix: resolve spinner issue
 *   perf(server)!: optimize database queries
 */
function parseConventionalCommit(message: string): ParsedCommit {
  // Remove merge commit noise
  const firstLine = message.split('\n')[0].trim();

  // Match: type(scope)?: subject or type?: subject
  const match = firstLine.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  if (!match) {
    return {
      type: 'other',
      subject: firstLine,
      isBreaking: false,
      rawMessage: message,
    };
  }

  const [, type, scope, breaking, subject] = match;

  return {
    type: type.toLowerCase(),
    scope,
    subject,
    isBreaking: !!breaking,
    rawMessage: message,
  };
}

/**
 * Extract PR numbers from commits
 * Looks for patterns like:
 * - "Merge pull request #N"
 * - "(#N)"
 * - "PR #N"
 */
function extractPRNumbers(commits: GitHubCommit[]): number[] {
  const prNumbers = new Set<number>();

  for (const commit of commits) {
    const message = commit.message;

    // Match "Merge pull request #N"
    const mergeMatch = message.match(/Merge pull request #(\d+)/i);
    if (mergeMatch) {
      prNumbers.add(parseInt(mergeMatch[1], 10));
      continue;
    }

    // Match "(#N)" or "PR #N" or "pr: #N"
    const prMatches = message.matchAll(/(?:^|\s|PR:?\s*)#(\d+)/gi);
    for (const match of prMatches) {
      prNumbers.add(parseInt(match[1], 10));
    }
  }

  return Array.from(prNumbers).sort((a, b) => a - b);
}

/**
 * Filter out noise commits (merges, trivial changes)
 */
function filterMeaningfulCommits(commits: GitHubCommit[]): GitHubCommit[] {
  return commits.filter(commit => {
    const msg = commit.message.toLowerCase();

    // Filter out merge commits
    if (msg.startsWith('merge ')) return false;

    // Filter out automated commits
    if (msg.includes('[skip ci]') || msg.includes('[ci skip]')) return false;

    return true;
  });
}

/**
 * Group commits by their associated PRs
 * Efficient approach: Extract PR numbers -> Fetch PR commits -> Match by SHA
 */
async function groupCommitsByPR(commits: GitHubCommit[], allCommits: GitHubCommit[]): Promise<CommitGroups> {
  // Step 1: Extract PR numbers from ALL commits (including merge commits before filtering)
  const prNumbers = extractPRNumbers(allCommits);

  console.log(`📥 Fetching details for ${prNumbers.length} PRs...`);

  // Step 2: Fetch PR details and commits for each PR (in parallel)
  const prDataPromises = prNumbers.map(async prNumber => {
    const prData = await getPRWithCommits(prNumber);
    if (prData) {
      return { prNumber, ...prData };
    }
    return null;
  });

  const prDataResults = await Promise.all(prDataPromises);
  const prDataList = prDataResults.filter((pr): pr is NonNullable<typeof pr> => pr !== null);

  console.log(`   ✅ Fetched ${prDataList.length} PR details\n`);

  // Step 3: Build SHA -> PR mapping
  const shaToPRMap = new Map<string, { prNumber: number; prTitle: string }>();
  for (const prData of prDataList) {
    for (const sha of prData.commitShas) {
      shaToPRMap.set(sha, { prNumber: prData.prNumber, prTitle: prData.title });
    }
  }

  // Step 4: Group commits by matching SHAs
  const prGroupsMap = new Map<number, PRGroup>();
  const standaloneCommits: GitHubCommit[] = [];

  for (const commit of commits) {
    const prInfo = shaToPRMap.get(commit.sha);
    if (prInfo) {
      if (!prGroupsMap.has(prInfo.prNumber)) {
        prGroupsMap.set(prInfo.prNumber, {
          prNumber: prInfo.prNumber,
          prTitle: prInfo.prTitle,
          commits: [],
        });
      }
      prGroupsMap.get(prInfo.prNumber)!.commits.push(commit);
    } else {
      standaloneCommits.push(commit);
    }
  }

  // Convert to array and sort by PR number (descending - newest first)
  const prGroups = Array.from(prGroupsMap.values()).sort((a, b) => b.prNumber - a.prNumber);

  return {
    prGroups,
    standaloneCommits,
  };
}

/**
 * Generate changelog prompt for AI
 */
function createChangelogPrompt(commitGroups: CommitGroups): string {
  const sections: string[] = [];

  // Format PR groups
  for (const prGroup of commitGroups.prGroups) {
    const commitMessages = prGroup.commits.map(c => `    - ${c.message.split('\n')[0]}`).join('\n');

    sections.push(
      `PR #${prGroup.prNumber}: ${prGroup.prTitle}\n  Commits (${prGroup.commits.length}):\n${commitMessages}`
    );
  }

  // Format standalone commits
  if (commitGroups.standaloneCommits.length > 0) {
    const standaloneList = commitGroups.standaloneCommits
      .map(c => {
        const date = new Date(c.date).toLocaleDateString();
        return `  - ${c.message.split('\n')[0]} (${c.author}, ${date})`;
      })
      .join('\n');

    sections.push(`Standalone commits (${commitGroups.standaloneCommits.length}):\n${standaloneList}`);
  }

  const commitList = sections.join('\n\n');

  return `You are a professional technical writer creating a changelog for a production deployment.

Here are the commits since the last release, grouped by pull request:

${commitList}

Generate a concise, user-focused changelog with these sections:
1. Features (🎯) - New capabilities and enhancements
2. Bug Fixes (🐛) - Issues resolved
3. Performance (⚡) - Speed and efficiency improvements
4. Internal (🔧) - Technical changes (only if significant and user-relevant)

Guidelines:
- Prioritize user-facing changes over internal refactors
- Use clear, non-technical language when possible
- Each item should be concise (1 line), action-oriented, and in past tense
- Omit trivial changes like typos, code formatting, or minor internal refactors
- If a change is a hotfix, mark it as such
- Create a title that summarizes the main theme of this release
- Identify the top 3-5 most important changes for a brief summary

Return ONLY a valid JSON object in this exact format (no markdown, no code blocks):
{
  "title": "Short descriptive title (3-7 words)",
  "sections": [
    {
      "type": "features",
      "items": ["Added user authentication with social login", "Implemented real-time progress tracking"]
    },
    {
      "type": "fixes",
      "items": ["Resolved infinite spinner on session end"]
    },
    {
      "type": "performance",
      "items": ["Enabled full static generation for 15% faster page loads"]
    },
    {
      "type": "internal",
      "items": ["Refactored database connection pooling"]
    }
  ],
  "briefSummary": [
    "Added user authentication with social login",
    "Resolved infinite spinner bug",
    "Enabled full static generation for faster loads"
  ]
}`;
}

/**
 * Generate fallback changelog if AI fails
 */
function generateFallbackChangelog(commits: GitHubCommit[], prNumbers: number[]): Changelog {
  const parsed = commits.map(c => parseConventionalCommit(c.message));

  const sections: ChangelogSection[] = [
    {
      type: 'features' as const,
      items: parsed.filter(c => c.type === 'feat').map(c => c.subject),
    },
    {
      type: 'fixes' as const,
      items: parsed.filter(c => c.type === 'fix').map(c => c.subject),
    },
    {
      type: 'performance' as const,
      items: parsed.filter(c => c.type === 'perf').map(c => c.subject),
    },
    {
      type: 'internal' as const,
      items: parsed
        .filter(c => c.type === 'refactor' || c.type === 'chore' || c.type === 'docs' || c.type === 'test')
        .map(c => c.subject),
    },
  ].filter(section => section.items.length > 0);

  // Create brief summary from top items
  const briefSummary: string[] = [];
  for (const section of sections) {
    briefSummary.push(...section.items.slice(0, 2));
    if (briefSummary.length >= 5) break;
  }

  return {
    title: 'Production Release',
    sections,
    briefSummary: briefSummary.slice(0, 5),
    metadata: {
      commitCount: commits.length,
      prNumber: null,
      prNumbers,
      deployedAt: new Date().toISOString(),
      deployNumber: 1,
    },
  };
}

/**
 * Generate changelog using AI (Bedrock via OperationsModelService)
 */
export async function generateChangelog(
  commits: GitHubCommit[],
  metadata: {
    prNumber: number | null;
    deployNumber: number;
  }
): Promise<Changelog> {
  // Extract PR numbers from all commits (before filtering)
  const prNumbers = extractPRNumbers(commits);

  // Filter out noise
  const meaningful = filterMeaningfulCommits(commits);

  if (meaningful.length === 0) {
    console.warn('⚠️  No meaningful commits found');
    return {
      title: 'Minor Updates',
      sections: [],
      briefSummary: ['Minor updates and maintenance'],
      metadata: {
        commitCount: 0,
        prNumber: metadata.prNumber,
        prNumbers,
        deployedAt: new Date().toISOString(),
        deployNumber: metadata.deployNumber,
      },
    };
  }

  console.log(`📝 Generating changelog for ${meaningful.length} commits using AI...`);
  if (prNumbers.length > 0) {
    console.log(`   Found ${prNumbers.length} PR(s): #${prNumbers.join(', #')}`);
  }

  // Group commits by PR (pass all commits for PR extraction, meaningful for grouping)
  const commitGroups = await groupCommitsByPR(meaningful, commits);

  console.log(
    `   Grouped into ${commitGroups.prGroups.length} PRs and ${commitGroups.standaloneCommits.length} standalone commits\n`
  );

  try {
    const prompt = createChangelogPrompt(commitGroups);

    // Use existing AnthropicBedrockBackend from @bike4mind/utils
    const backend = new AnthropicBedrockBackend({ region: 'us-east-2' });
    const modelId = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;

    let result = '';
    await backend.complete(
      modelId,
      [{ role: 'user', content: prompt }],
      { maxTokens: 2000, stream: true },
      async (chunks: (string | null | undefined)[]) => {
        result += chunks.filter(Boolean).join('');
      }
    );

    // Parse AI response
    const trimmed = result.trim();

    // Remove markdown code blocks if present
    const cleaned = trimmed.replace(/^```json?\n?/, '').replace(/\n?```$/, '');

    let parsed: {
      title: string;
      sections: ChangelogSection[];
      briefSummary: string[];
    };

    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('❌ Failed to parse AI response:', parseError);
      console.error('AI response:', cleaned);
      console.log('⚠️  Falling back to conventional commit parsing');
      return generateFallbackChangelog(meaningful, prNumbers);
    }

    // Validate response structure
    if (!parsed.title || !parsed.sections || !parsed.briefSummary) {
      console.error('❌ Invalid AI response structure:', parsed);
      console.log('⚠️  Falling back to conventional commit parsing');
      return generateFallbackChangelog(meaningful, prNumbers);
    }

    console.log('✅ Changelog generated successfully');

    return {
      title: parsed.title,
      sections: parsed.sections,
      briefSummary: parsed.briefSummary,
      metadata: {
        commitCount: meaningful.length,
        prNumber: metadata.prNumber,
        prNumbers,
        deployedAt: new Date().toISOString(),
        deployNumber: metadata.deployNumber,
      },
    };
  } catch (error) {
    console.error('❌ AI changelog generation failed:', error);
    console.log('⚠️  Falling back to conventional commit parsing');
    return generateFallbackChangelog(meaningful, prNumbers);
  }
}

/**
 * Format changelog as GitHub Release markdown
 */
export function formatChangelogMarkdown(changelog: Changelog): string {
  let markdown = '';

  // Add sections
  for (const section of changelog.sections) {
    if (section.items.length === 0) continue;

    const headers = {
      features: '## 🎯 Features',
      fixes: '## 🐛 Bug Fixes',
      performance: '## ⚡ Performance',
      internal: '## 🔧 Internal',
      hotfix: '## 🔥 Hotfixes',
    };

    markdown += `${headers[section.type]}\n`;
    for (const item of section.items) {
      markdown += `- ${item}\n`;
    }
    markdown += '\n';
  }

  // Add metadata
  const { commitCount, prNumber, prNumbers, deployedAt } = changelog.metadata;
  const timestamp = new Date(deployedAt).toISOString().replace('T', ' ').split('.')[0] + ' UTC';

  const metadataLine = [
    `**Deployed**: ${timestamp}`,
    `**Commits**: ${commitCount}`,
    prNumber ? `**PR**: #${prNumber}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  markdown += `---\n${metadataLine}\n`;

  // Add PR list if there are multiple PRs
  if (prNumbers.length > 0) {
    markdown += '\n**Pull Requests**: ';
    markdown += prNumbers.map(pr => `#${pr}`).join(', ');
    markdown += '\n';
  }

  return markdown.trim();
}
