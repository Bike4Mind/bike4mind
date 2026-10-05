/**
 * Resolve the commit SHA a production release should be built from.
 *
 * `HEAD` is only a valid value during a dry run (local/manual testing); a real
 * run must be anchored to the exact 40-character SHA that was deployed, since
 * the release tag's target_commitish is read straight from this value.
 */
export function resolveDeployedSha(input: string | undefined, options: { dryRun: boolean }): string {
  const normalized = input?.trim();

  if (!normalized || normalized.toUpperCase() === 'HEAD') {
    if (options.dryRun) {
      return 'HEAD';
    }
    throw new Error('deployed_sha (or target_branch) is required for a real run; "HEAD" is only valid for --dry-run');
  }

  const lowered = normalized.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lowered)) {
    throw new Error(`deployed_sha must be a 40-character commit SHA, got: "${input}"`);
  }

  return lowered;
}
