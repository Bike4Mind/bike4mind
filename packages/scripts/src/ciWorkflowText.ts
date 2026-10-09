// Text-level readers over ci.yml shared by the checkXxxJobWired tests (no YAML parser dependency).

export type Job = { name: string; body: string };

/**
 * Jobs under the workflow's `jobs:` key, as name -> the job mapping's source text.
 *
 * Comment lines are dropped first: ci.yml's job docblocks quote `needs:`, `if:` and the artifact
 * name while explaining them, and prose that reads like a declaration must not count as one.
 */
export function readJobs(contents: string): Job[] {
  const lines = contents.split('\n').filter(line => !/^\s*#/.test(line));
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (start === -1) return [];

  const jobs: Job[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      jobs.push({ name: header[1], body: '' });
    } else if (jobs.length > 0) {
      jobs[jobs.length - 1].body += `${line}\n`;
    }
  }
  return jobs;
}

/**
 * A job's `if:` value as one line, folding the block-scalar form (`if: |`) back together.
 *
 * The block form is not cosmetic here: `!` opens a YAML tag, so the inline `if: !cancelled() &&
 * ...` that a reader might collapse this to is a parse error rather than a condition.
 */
export function readJobCondition(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex(line => /^ {4}if:/.test(line));
  if (start === -1) return '';

  const inline = lines[start].replace(/^ {4}if:\s*/, '').trim();
  if (!/^[|>][-+]?$/.test(inline)) return inline;

  const folded: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^ {6}/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}
