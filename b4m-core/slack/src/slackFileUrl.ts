/** Hosts Slack serves private file downloads from; the bot token is only ever sent to these. */
const SLACK_FILE_HOSTS: readonly string[] = ['files.slack.com', 'files-edu.slack.com', 'files.slack-gov.com'];

export function isSlackFileUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.port === '' || url.port === '443') &&
    SLACK_FILE_HOSTS.includes(url.hostname.toLowerCase())
  );
}
