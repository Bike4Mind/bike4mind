/**
 * PR report generator - the inbound and outbound guards.
 *
 * Both values these guard come from the same admin-editable trust tier, and both are
 * interpolated into authenticated network calls. The repo string decides where a
 * bearer token is sent; the chat destination decides where the entire report body
 * goes. Neither may be left less validated than the other.
 */

import type { ChatPostTarget } from '@bike4mind/services';

/**
 * GitHub's repo grammar, fully anchored.
 *
 * Owner: alphanumeric with internal hyphens, max 39 characters.
 * Repo: alphanumeric plus `.`, `-`, `_`, max 100 characters.
 *
 * Anchoring is the point - an unanchored pattern matches a substring, so
 * `evil.example.com/?x=owner/repo` would pass and redirect a token-bearing request
 * to an attacker's host.
 */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Assert the admin-controlled repo identifier before it is interpolated into any
 * authenticated outbound URL. SSRF / token-exfiltration mitigation.
 *
 * Note this is deliberately stricter than GitHubService's own internal `parseRepo`,
 * whose per-segment character class permits `.` and therefore accepts a literal `..`
 * segment. Path traversal in a repo path is what turns an API call into a request
 * against an unintended resource, so it is rejected explicitly here rather than
 * assumed away.
 */
export function assertRepoFormat(repo: string): void {
  if (!repo || typeof repo !== 'string') {
    throw new Error('repository identifier is not configured');
  }

  const trimmed = repo.trim();

  if (trimmed !== repo) {
    throw new Error('repository identifier has leading or trailing whitespace');
  }
  if (!REPO_PATTERN.test(trimmed)) {
    throw new Error('repository identifier does not match the expected owner/repo format');
  }
  // Redundant against the anchored pattern for `..` as a whole segment, but kept
  // explicit: this is the traversal case, and it should fail for a stated reason
  // rather than incidentally.
  if (trimmed.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('repository identifier contains an empty or relative path segment');
  }
}

export interface ChatEgressPolicy {
  /**
   * Hosts the digest may be posted to. OPERATOR-CONFIGURED, not compiled in: a
   * self-hosted chat platform has no provider domain, so its allowlist is the
   * operator's own host.
   */
  allowedHosts: string[];
  /**
   * The API origin the post will actually reach. Defaults to Slack's. A self-hosted
   * deployment overrides it, which is exactly why the allowlist cannot be baked in.
   */
  apiBaseUrl?: string;
}

const DEFAULT_SLACK_API_BASE_URL = 'https://slack.com/api/';

/**
 * Build the egress guard - the outbound-side analogue of `assertRepoFormat`.
 *
 * The post body is the entire report: PR titles, author logins, repo URLs, and the
 * staffing implied by the role rosters. An unvalidated destination is a
 * data-exfiltration channel, not merely a broken post.
 *
 * FAILS CLOSED. An unset or empty allowlist rejects every post and MUST NOT degrade
 * to allowing any host - a guard that quietly becomes a pass-through leaves open the
 * exact channel it was added to close. That fail-closed state is every deployment's
 * first-run state, which is why the rejection has its own terminal shape
 * (`targetRejected`) rather than surfacing as a generic 500 with no obvious cause.
 *
 * No message below names the value it rejected. The guard is handed the whole
 * `ChatPostTarget`, so an error built from its input would return a
 * bearer-equivalent credential to the browser.
 */
export function createAssertChatTargetFormat(policy: ChatEgressPolicy) {
  return function assertChatTargetFormat(destination: ChatPostTarget | null | undefined): void {
    if (!destination || !destination.token || !destination.channel) {
      throw new Error('no destination configured');
    }

    if (!policy.allowedHosts?.length) {
      throw new Error('no egress allowlist configured');
    }

    // A bot-token target carries no URL of its own, so the egress that actually
    // happens is the API origin the client posts to. Validating that keeps the
    // allowlist load-bearing instead of decorative - the blueprint's "a URL-less
    // target passes" would otherwise leave this deployment's only egress unchecked.
    let origin: URL;
    try {
      origin = new URL(policy.apiBaseUrl ?? DEFAULT_SLACK_API_BASE_URL);
    } catch {
      throw new Error('configured chat API base URL is not a valid URL');
    }

    if (origin.protocol !== 'https:') {
      throw new Error('destination is not HTTPS');
    }

    const allowed = policy.allowedHosts.some(host => host.trim().toLowerCase() === origin.hostname.toLowerCase());
    if (!allowed) {
      throw new Error('destination host is not on the egress allowlist');
    }
  };
}
