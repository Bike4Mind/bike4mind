import { IConversationContext } from '@bike4mind/common';

/**
 * Format a relative time string (e.g., "2 min ago", "1 hour ago")
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffMinutes < 1) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else {
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }
}

/**
 * Options for building the context prompt
 */
export interface PromptBuilderOptions {
  /** Maximum number of entities to include per category */
  maxEntitiesPerCategory?: number;
  /** Whether to include timestamps */
  includeTimestamps?: boolean;
  /** User's enabled GitHub repositories (for validation hints) */
  enabledGitHubRepos?: string[];
  /** User's enabled Jira projects (for validation hints) */
  enabledJiraProjects?: string[];
}

const DEFAULT_OPTIONS: Required<PromptBuilderOptions> = {
  maxEntitiesPerCategory: 5,
  includeTimestamps: true,
  enabledGitHubRepos: [],
  enabledJiraProjects: [],
};

/**
 * Build a system prompt section for conversation context
 *
 * @param context - The conversation context
 * @param options - Options for building the prompt
 * @returns The formatted prompt section, or empty string if no context
 */
export function buildContextPrompt(
  context: IConversationContext | null | undefined,
  options: PromptBuilderOptions = {}
): string {
  if (!context) {
    return '';
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];

  const githubSection = buildGitHubSection(context, opts);
  if (githubSection) {
    sections.push(githubSection);
  }

  const jiraSection = buildJiraSection(context, opts);
  if (jiraSection) {
    sections.push(jiraSection);
  }

  const confluenceSection = buildConfluenceSection(context, opts);
  if (confluenceSection) {
    sections.push(confluenceSection);
  }

  if (sections.length === 0) {
    return '';
  }

  return `## Conversation Context

Recently mentioned entities (use these when user refers to "the PR", "that issue", "the page", etc.):

${sections.join('\n\n')}

### Reference Resolution Guidelines
- If ONE entity clearly matches the user's reference → use it directly
- If MULTIPLE entities could match → ask the user with ranked options (most recent first)
- Always validate against user's enabled repositories/projects before taking action
- When uncertain, prefer asking for clarification over guessing`;
}

/**
 * Build the GitHub section of the context prompt
 */
function buildGitHubSection(context: IConversationContext, opts: Required<PromptBuilderOptions>): string {
  if (!context.github) {
    return '';
  }

  const lines: string[] = [];
  const { repos, prs, issues } = context.github;

  // Sort by mentionedAt descending (most recent first)
  const sortedRepos = [...repos].sort((a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime());
  const sortedPRs = [...prs].sort((a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime());
  const sortedIssues = [...issues].sort(
    (a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime()
  );

  // Build repos list
  if (sortedRepos.length > 0) {
    lines.push('**GitHub Repositories:**');
    const reposToShow = sortedRepos.slice(0, opts.maxEntitiesPerCategory);
    for (const repo of reposToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(repo.mentionedAt))})` : '';
      const isPrimary = reposToShow.indexOf(repo) === 0 ? ' ← primary' : '';
      lines.push(`- ${repo.owner}/${repo.repo}${timestamp}${isPrimary}`);
    }
  }

  // Build PRs list
  if (sortedPRs.length > 0) {
    lines.push('**GitHub Pull Requests:**');
    const prsToShow = sortedPRs.slice(0, opts.maxEntitiesPerCategory);
    for (const pr of prsToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(pr.mentionedAt))})` : '';
      const title = pr.title ? `: "${pr.title}"` : '';
      lines.push(`- PR #${pr.number} in ${pr.owner}/${pr.repo}${title}${timestamp}`);
    }
  }

  // Build issues list
  if (sortedIssues.length > 0) {
    lines.push('**GitHub Issues:**');
    const issuesToShow = sortedIssues.slice(0, opts.maxEntitiesPerCategory);
    for (const issue of issuesToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(issue.mentionedAt))})` : '';
      const title = issue.title ? `: "${issue.title}"` : '';
      lines.push(`- Issue #${issue.number} in ${issue.owner}/${issue.repo}${title}${timestamp}`);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  return lines.join('\n');
}

/**
 * Build the Jira section of the context prompt
 */
function buildJiraSection(context: IConversationContext, opts: Required<PromptBuilderOptions>): string {
  if (!context.jira) {
    return '';
  }

  const lines: string[] = [];
  const { projects, issues } = context.jira;

  // Sort by mentionedAt descending
  const sortedProjects = [...projects].sort(
    (a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime()
  );
  const sortedIssues = [...issues].sort(
    (a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime()
  );

  // Build projects list
  if (sortedProjects.length > 0) {
    lines.push('**Jira Projects:**');
    const projectsToShow = sortedProjects.slice(0, opts.maxEntitiesPerCategory);
    for (const project of projectsToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(project.mentionedAt))})` : '';
      const name = project.name ? ` - ${project.name}` : '';
      lines.push(`- ${project.key}${name}${timestamp}`);
    }
  }

  // Build issues list
  if (sortedIssues.length > 0) {
    lines.push('**Jira Issues:**');
    const issuesToShow = sortedIssues.slice(0, opts.maxEntitiesPerCategory);
    for (const issue of issuesToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(issue.mentionedAt))})` : '';
      const summary = issue.summary ? `: "${issue.summary}"` : '';
      lines.push(`- ${issue.key}${summary}${timestamp}`);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  return lines.join('\n');
}

/**
 * Build the Confluence section of the context prompt
 */
function buildConfluenceSection(context: IConversationContext, opts: Required<PromptBuilderOptions>): string {
  if (!context.confluence) {
    return '';
  }

  const lines: string[] = [];
  const { spaces, pages } = context.confluence;

  // Sort by mentionedAt descending
  const sortedSpaces = [...spaces].sort(
    (a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime()
  );
  const sortedPages = [...pages].sort((a, b) => new Date(b.mentionedAt).getTime() - new Date(a.mentionedAt).getTime());

  // Build spaces list
  if (sortedSpaces.length > 0) {
    lines.push('**Confluence Spaces:**');
    const spacesToShow = sortedSpaces.slice(0, opts.maxEntitiesPerCategory);
    for (const space of spacesToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(space.mentionedAt))})` : '';
      const name = space.name ? ` - ${space.name}` : '';
      lines.push(`- ${space.key}${name}${timestamp}`);
    }
  }

  // Build pages list
  if (sortedPages.length > 0) {
    lines.push('**Confluence Pages:**');
    const pagesToShow = sortedPages.slice(0, opts.maxEntitiesPerCategory);
    for (const page of pagesToShow) {
      const timestamp = opts.includeTimestamps ? ` (${formatRelativeTime(new Date(page.mentionedAt))})` : '';
      const space = page.spaceKey ? ` in ${page.spaceKey}` : '';
      lines.push(`- "${page.title}"${space}${timestamp}`);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  return lines.join('\n');
}

/**
 * Check if context has any meaningful entities
 */
export function hasContext(context: IConversationContext | null | undefined): boolean {
  if (!context) {
    return false;
  }

  const hasGitHub =
    (context.github?.repos?.length ?? 0) > 0 ||
    (context.github?.prs?.length ?? 0) > 0 ||
    (context.github?.issues?.length ?? 0) > 0;

  const hasJira = (context.jira?.projects?.length ?? 0) > 0 || (context.jira?.issues?.length ?? 0) > 0;

  const hasConfluence = (context.confluence?.spaces?.length ?? 0) > 0 || (context.confluence?.pages?.length ?? 0) > 0;

  return hasGitHub || hasJira || hasConfluence;
}
