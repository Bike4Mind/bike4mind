/**
 * GitHub API helpers for release management
 */

interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  created_at: string;
  target_commitish: string;
  html_url: string;
}

interface CreateReleaseOptions {
  tag: string;
  name: string;
  body: string;
  targetCommitish?: string;
}

/**
 * Get GitHub repository info from environment
 */
function getRepoInfo(): { owner: string; repo: string } {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY environment variable not set');
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY format: ${repository}`);
  }

  return { owner, repo };
}

/**
 * Get GitHub token from environment
 */
function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable not set');
  }
  return token;
}

/**
 * Make a GitHub API request
 */
async function githubRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getGitHubToken();
  const url = `https://api.github.com${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get the latest production release
 * @param tagPattern - Optional pattern to filter tags (e.g., 'v*')
 * @returns Latest release or null if none exists
 */
export async function getLatestRelease(tagPattern?: RegExp): Promise<GitHubRelease | null> {
  const { owner, repo } = getRepoInfo();

  try {
    const releases = await githubRequest<GitHubRelease[]>(`/repos/${owner}/${repo}/releases?per_page=100`);

    if (releases.length === 0) return null;

    // Filter by pattern if provided
    if (tagPattern) {
      const filtered = releases.filter(r => tagPattern.test(r.tag_name));
      return filtered[0] || null;
    }

    return releases[0];
  } catch (error) {
    // No releases yet
    if ((error as Error).message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * Get commits between two references
 * @param base - Base commit SHA or ref
 * @param head - Head commit SHA or ref (defaults to HEAD)
 * @returns Array of commits
 */
export async function getCommitRange(base: string, head: string = 'HEAD'): Promise<GitHubCommit[]> {
  const { owner, repo } = getRepoInfo();

  const comparison = await githubRequest<{
    commits: Array<{
      sha: string;
      commit: {
        message: string;
        author: { name: string; email: string; date: string };
      };
    }>;
  }>(`/repos/${owner}/${repo}/compare/${base}...${head}`);

  return comparison.commits.map(c => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author.name,
    authorEmail: c.commit.author.email,
    date: c.commit.author.date,
  }));
}

/**
 * Get commits since the last release
 * @param targetBranch - Branch to compare against (defaults to 'HEAD' for flexibility in testing)
 * @returns Array of commits since last release
 */
export async function getCommitsSinceLastRelease(targetBranch: string = 'HEAD'): Promise<GitHubCommit[]> {
  const latestRelease = await getLatestRelease(/^v\d+\.\d+\.\d+\.\d+$/);

  if (!latestRelease) {
    // No previous releases, get all commits on current branch
    const { owner, repo } = getRepoInfo();
    const commits = await githubRequest<
      Array<{
        sha: string;
        commit: {
          message: string;
          author: { name: string; email: string; date: string };
        };
      }>
    >(`/repos/${owner}/${repo}/commits?per_page=100`);

    return commits.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author.name,
      authorEmail: c.commit.author.email,
      date: c.commit.author.date,
    }));
  }

  // Compare from the release tag (specific commit) to target branch
  // Using tag_name ensures we get commits since the tagged release
  // Using HEAD as default allows testing from any branch (flexible for manual/local testing)
  // For production, the workflow explicitly checks out 'prod' so HEAD = prod
  return getCommitRange(latestRelease.tag_name, targetBranch);
}

/**
 * Create a new GitHub release
 * @param options - Release creation options
 * @returns Created release
 */
export async function createRelease(options: CreateReleaseOptions): Promise<GitHubRelease> {
  const { owner, repo } = getRepoInfo();

  return githubRequest<GitHubRelease>(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag_name: options.tag,
      name: options.name,
      body: options.body,
      target_commitish: options.targetCommitish || 'prod',
      draft: false,
      prerelease: false,
    }),
  });
}

/**
 * Get the current pull request number from GitHub Actions environment
 * @returns PR number or null if not in PR context
 */
export function getCurrentPRNumber(): number | null {
  // GitHub Actions sets this environment variable for pull_request events
  const prNumber = process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER;
  if (prNumber) {
    return parseInt(prNumber, 10);
  }

  // Fallback: parse from GITHUB_REF (e.g., refs/pull/123/merge)
  const ref = process.env.GITHUB_REF;
  if (ref) {
    const match = ref.match(/refs\/pull\/(\d+)\//);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

/**
 * Get repository URL
 */
export function getRepoUrl(): string {
  const { owner, repo } = getRepoInfo();
  return `https://github.com/${owner}/${repo}`;
}

/**
 * Pull Request details (minimal for changelog context)
 */
export interface PRDetail {
  number: number;
  title: string;
}

/**
 * Get a pull request title by number
 */
export async function getPRTitle(prNumber: number): Promise<string | null> {
  const { owner, repo } = getRepoInfo();

  try {
    const pr = await githubRequest<{ title: string }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return pr.title;
  } catch (error) {
    if ((error as Error).message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * Get PR details with all commits
 */
export async function getPRWithCommits(prNumber: number): Promise<{
  title: string;
  commitShas: string[];
} | null> {
  const { owner, repo } = getRepoInfo();

  try {
    // Fetch PR details and commits in parallel
    const [pr, commits] = await Promise.all([
      githubRequest<{ title: string }>(`/repos/${owner}/${repo}/pulls/${prNumber}`),
      githubRequest<Array<{ sha: string }>>(`/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`),
    ]);

    return {
      title: pr.title,
      commitShas: commits.map(c => c.sha),
    };
  } catch (error) {
    if ((error as Error).message.includes('404')) {
      return null;
    }
    throw error;
  }
}
