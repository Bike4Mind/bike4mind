import type { AdminGuideEntry } from '../types';

export const OPERATIONS_GUIDE: readonly AdminGuideEntry[] = [
  {
    id: 'system-health',
    title: 'System Health',
    summary:
      'A diagnostic page that checks email, database and OAuth provider configuration and probes third-party integrations. Use it to confirm a deployment is set up correctly and to send test messages.',
    views: ['admin.system_health'],
    settings: [],
    howTo: [
      'Open System Health. Cards for Email Configuration, Database Configuration and OAuth Providers show what is configured and what is missing. Click Refresh to re-check.',
      'On the Email Configuration card, click Send Test Email (enabled once email is configured) to send a test message and see the result.',
      'On the OAuth Providers card, click Test <provider> (for example Test Google) to check that a provider responds. The button is disabled while that provider is not configured.',
      'On the integration health card, click Probe All (or Probe on one integration). Block, Force Open and Reset to Auto (all users) override an integration circuit breaker; which ones show depends on its current mode. The Integrations page has the per-integration detail.',
    ],
    keywords: [
      'health check',
      'diagnostics',
      'test email',
      'smtp',
      'oauth test',
      'circuit breaker',
      'configuration status',
    ],
  },
  {
    id: 'slack-workspaces',
    title: 'Slack Workspaces',
    summary:
      'Lists every Slack workspace connected to the platform and lets an admin create a Slack app, install the bot, keep the app manifest current, export channel history and deactivate a workspace.',
    views: ['admin.slack_workspaces'],
    settings: [],
    howTo: [
      'Open Slack Workspaces. The table shows Workspace, Team ID, App ID, Bot Name, Installed, Status and Manifest for each workspace; use Refresh to reload it.',
      'Click Create Slack App to set up a new Slack app. For a workspace that shows Not Installed, click Install in its Actions column.',
      'In the Manifest column, use the Update manifest icon when an update is available, or the Reconnect configuration token icon when a new Slack configuration token is needed.',
      'Use Export channel history to download a channel as JSON, CSV or Markdown, optionally with a date range and as a background export. Deactivate workspace turns a workspace off.',
    ],
    keywords: [
      'slack bot',
      'slack app',
      'install slack',
      'manifest',
      'export channel',
      'deactivate workspace',
      'configuration token',
    ],
  },
  {
    id: 'secrets-rotation',
    title: 'Secrets rotation',
    summary:
      'Tracks which secrets are on a rotation schedule, when each was last renewed and when the next rotation is due, so overdue secrets are easy to spot.',
    views: ['admin.secrets_rotation'],
    settings: [],
    howTo: [
      'Open Secrets rotation. Each row shows the secret, its description, interval in days, last renewed, last renewed by, next rotation and a status of Active, Overdue or Inactive.',
      'Open the row menu, choose Mark renewed and confirm. This records you as the person who renewed it and restarts its cycle. It needs update permission on secret rotations. For other secrets, click it after you rotate them in the source system.',
      'For the signing secret, click Mark renewed BEFORE you deploy the replacement secret: it snapshots the secret the running process uses, and a capture that matches the last one is refused.',
      'To change a schedule, open the row menu, choose Edit rotation, set the description and the rotation interval (1 to 365 days), then click Save changes.',
    ],
    keywords: ['rotate keys', 'credential rotation', 'overdue secret', 'renew secret', 'key expiry'],
  },
  {
    id: 'system-secrets',
    title: 'System secrets',
    summary:
      'Shows the state of platform secrets: infrastructure secrets that are set outside the app (read-only here) and configurable secrets that an admin can override from the UI.',
    views: ['admin.system_secrets'],
    settings: [],
    howTo: [
      'Open System secrets. The Infrastructure secrets (SST) table is read-only and shows a status chip per secret; hover a chip for detail. Those secrets are changed with the deployment tooling, not here.',
      'In Configurable secrets, rows are grouped by category and show the source (GUI override, SST or Not configured) and a masked value.',
      'To set a value, open the row menu, choose Edit value, enter the new value and click Save value. Values are stored encrypted and shown masked afterwards.',
      'To go back to the infrastructure value, open the row menu on a GUI override and choose Delete override, then confirm.',
    ],
    keywords: ['environment variables', 'env vars', 'secret override', 'gui override', 'sst secret', 'api keys config'],
  },
  {
    id: 'liveops-triage',
    title: 'LiveOps Triage',
    summary:
      'Manages triage configurations that read error alerts from a Slack channel, use an AI model to prioritize them and file GitHub or Jira issues. Each configuration can be dry-run, run on demand and reviewed in run history.',
    views: ['admin.liveops_triage'],
    settings: [],
    howTo: [
      'Open LiveOps Triage. The left list shows each configuration with its tracker, interval and an On or Off chip. Click Add for a new one, or select one to edit it.',
      'Fill in the name, issue tracker Type (GitHub or Jira), Slack workspace, source and output channel, run interval, model and Max Errors Per Run, then click Create or Save.',
      'Click Dry Run to see what would be filed without creating issues. Click Run Now to create real issues (the tooltip warns it is not a test). Both open the Lookback Period modal, where you pick the period.',
      'Use the Active Runs section to follow current and recent runs. The System Health card in a configuration shows whether its dependencies are ready.',
    ],
    keywords: [
      'error alerts',
      'incident triage',
      'create github issues',
      'jira issues',
      'dry run',
      'run now',
      'run history',
      'prompt template',
    ],
  },
  {
    id: 'sre-agent',
    title: 'SRE agent',
    summary:
      'Configures and monitors the pipeline that detects production errors, diagnoses them with an AI model and proposes fixes as pull requests, with optional human approval in Slack.',
    views: ['admin.sre_agent'],
    settings: ['sreAgentConfig'],
    howTo: [
      'Open SRE agent. The Pipeline Status tab shows activity metrics and tracked errors; filter by repository and use the row actions to retry, rerun or dismiss a tracking entry (dismissing needs a reason).',
      'The Pattern Library tab lists known error patterns the agent can reuse, filtered by repository.',
      'The Configuration tab lists Repositories. Each repository card has sections: Master Controls (Pipeline Enabled, Dry Run Mode, daily and size limits), Model Configuration, Integrations, Error Sources, Approval Gates, File Scope and Safety & Limits.',
      'Start with Dry Run Mode on and review results in Pipeline Status before letting the pipeline open pull requests.',
    ],
    keywords: [
      'sre',
      'auto-fix',
      'error diagnosis',
      'production errors',
      'fix pull requests',
      'pattern library',
      'pipeline status',
    ],
  },
  {
    id: 'integration-health',
    title: 'Integration Health',
    summary:
      'A dashboard of the health and uptime of third-party integrations such as GitHub, Jira, Confluence and Slack, with latency history, probe results and circuit breaker controls.',
    views: ['admin.integrations'],
    settings: [],
    howTo: [
      'Open Integrations. The header counts Healthy, Degraded and Down integrations; the page auto-refreshes every 30 seconds.',
      'Pick 24h, 7d or 30d to change the history range, and click Run Probes to check every integration now.',
      'Select an integration for its detail panel (the System Health page has a shorter set of circuit breaker buttons). Under the database-backed override, choose Auto (all users), Force Open or Force Block to control its circuit breaker.',
      'Click Export CSV to download the history.',
    ],
    keywords: ['uptime', 'outage', 'third-party status', 'circuit breaker', 'probes', 'latency', 'integration down'],
  },
  {
    id: 'dead-letters',
    title: 'Dead letters',
    summary:
      'Shows failed background messages that ended up in dead-letter queues and lets an admin inspect them and replay them back to their source queue.',
    views: ['admin.dead_letters'],
    settings: [],
    howTo: [
      'Open Dead letters. Summary cards show Total DLQs, DLQs with Messages and Total Failed Messages. Choose a queue under Select DLQ to list its messages.',
      'Click View details on a message to see its full body and metadata.',
      'Click Replay this message for one message, or Replay All (up to 100) and confirm with Replay Messages. Messages that were already replayed several times are skipped.',
      'Use History to review earlier replays, filtered by Status (success, failed, skipped), Date Range and Search.',
    ],
    keywords: ['dlq', 'failed messages', 'replay', 'retry queue', 'sqs', 'poison message'],
  },
  {
    id: 'stuck-executions',
    title: 'Stuck executions',
    summary:
      'Finds agent executions that have not made progress and lets an admin mark them abandoned so the user concurrency slots they hold are released.',
    views: ['admin.stuck_executions'],
    settings: [],
    howTo: [
      'Open Stuck executions. Set Older than (minutes), and optionally Status or User ID, to narrow the list. Click Refresh to reload.',
      'Executions waiting on a sub-agent are not listed, because those can legitimately idle for a long time.',
      'Select the rows you want and click Mark abandoned (n). This needs the settings:manage permission.',
    ],
    keywords: ['hung agent', 'stalled', 'concurrency slots', 'release slot', 'agent executions', 'abandon'],
  },
  {
    id: 'github-connection',
    title: 'GitHub connection',
    summary:
      'Configures the system-level GitHub connection used by platform automation, either a GitHub App or a service-account token, and the list of repositories it may reach.',
    views: ['admin.github'],
    settings: [],
    howTo: [
      'Open GitHub. If nothing is connected, click Connect GitHub App (App ID, Installation ID and private key) or Connect with PAT (a fine-grained token, optional expiration date).',
      'Once connected, the Connection Health and Rate Limit cards show status; click refresh to load rate limit info.',
      'Under Allowed Repositories, search and tick the repositories automation may use, then click Save. An empty list blocks all repository access, and saving it asks for confirmation.',
      'Use Rotate Private Key to replace a GitHub App key, or Disconnect to remove the connection.',
    ],
    keywords: [
      'github app',
      'personal access token',
      'pat',
      'repository allow-list',
      'repo whitelist',
      'rotate private key',
      'source control',
    ],
  },
  {
    id: 'webhook-logs',
    title: 'Webhook logs',
    summary:
      'Lists incoming GitHub webhook deliveries with status, duration and sender, plus summary stats, so an admin can see what arrived and how it was processed.',
    views: ['admin.webhook_logs'],
    settings: [],
    howTo: [
      'Open Webhook logs. The top cards show Total Deliveries, Success Rate, Avg Duration (with P95) and Failures for the chosen Date Range.',
      'Filter by Date Range, Source, Repository, Event Type and Status.',
      'Click a delivery to open Webhook Details with its payload and processing outcome.',
    ],
    keywords: ['webhook deliveries', 'payload', 'failed webhook', 'github events', 'delivery status'],
  },
  {
    id: 'integration-demand',
    title: 'Integration demand',
    summary:
      'Shows which integrations users have asked for from the roadmap cards on the Integrations page, most requested first, and who asked.',
    views: ['admin.integration_demand'],
    settings: [],
    howTo: [
      'Open Integration demand. The tiles show Integrations requested, Requests and Live integrations.',
      'Use the saved views All demand, Roadmap and Live, the Stage filter (Roadmap, Beta, Live) or Search integrations to narrow the table.',
      'Select a row to see Who requested that integration, with the organization and request date.',
    ],
    keywords: ['integration requests', 'roadmap', 'requested integrations', 'feature demand', 'most requested'],
  },
  {
    id: 'pr-digest',
    title: 'PR digest',
    summary:
      'Generates a Slack digest of open pull requests for one repository. An admin reviews and edits the draft, and nothing is posted until Send to Slack is pressed.',
    views: ['admin.pr_digest'],
    settings: ['prReportRepo', 'prReportIdentityMap', 'prReportWebhookUrl', 'prReportEgressAllowlist'],
    howTo: [
      'Open PR digest. In Source, enter the Repository as owner/repo. In Slack delivery, set the Slack webhook URL (stored encrypted, never shown again), the Identity map of GitHub names to Slack member IDs, and the Egress allowlist hosts.',
      'Save the settings, then click Generate digest (it is disabled until a repository is saved).',
      'In the PR digest dialog, edit the draft, use Preview mentions to check who will be mentioned, then click Send to Slack.',
      'If the dialog says the post may not have landed, check the channel before retrying.',
    ],
    keywords: ['pull request report', 'weekly digest', 'slack digest', 'open prs', 'identity map', 'webhook url'],
  },
  {
    id: 'identity-providers',
    title: 'Identity Providers',
    summary:
      'Configures single sign-on with SAML or Okta. Each provider is tied to an email domain so users with that domain are sent to their company login.',
    views: ['admin.identity_providers'],
    settings: [],
    howTo: [
      'Open Identity Providers and click Add identity provider. Set Name, Email Domain, Type (SAML or Okta) and Active.',
      'For SAML, enter Entry Point (SSO URL), Issuer and Certificate. For Okta, enter Audience (Okta Domain), Client ID and Client Secret.',
      'Open a row menu for View SP metadata (SAML only, gives the ACS URL and Entity ID for the identity provider side), Edit provider or Delete provider.',
      'To stop a provider without losing its setup, edit it and turn Active off. Deleting asks you to type the provider name and cannot be undone.',
    ],
    keywords: ['sso', 'saml', 'okta', 'single sign-on', 'login providers', 'email domain', 'sp metadata'],
  },
  {
    id: 'event-metrics',
    title: 'Event metrics',
    summary: 'Charts recorded product events by date, category, event and user, with a per-user activity view.',
    views: ['admin.event_metrics'],
    settings: [],
    howTo: [
      'Open Event metrics. The Events view shows overview charts, usage by source, curation breakdown and raw data for the selected range.',
      'Use the Range chips or date fields, and the Category, Event and User filters, then apply them.',
      'Switch to By user with the Events / By user control to look at activity for individual users.',
    ],
    keywords: ['activity tracking', 'event analytics', 'usage events', 'user activity', 'product analytics'],
  },
  {
    id: 'slack-metrics',
    title: 'Slack Metrics',
    summary:
      'Charts how the Slack integration is used: event activity, agent usage, intent breakdown and export formats and success rate.',
    views: ['admin.slack_metrics'],
    settings: [],
    howTo: [
      'Open Slack Metrics to see the Slack Event Activity, Agent Usage, Intent Breakdown, Export Formats and Export Success Rate charts.',
      'If a filter leaves nothing to show, clear it. A No Slack events yet message means the integration has not recorded any activity.',
    ],
    keywords: ['slack usage', 'message analytics', 'slack stats', 'slack activity', 'agent usage'],
  },
  {
    id: 'help-analytics',
    title: 'Help usage',
    summary:
      'Shows what users do in the in-app help: article views, searches, article feedback and questions asked in the help chat, including searches that found nothing.',
    views: ['admin.help_analytics'],
    settings: [],
    howTo: [
      'Open Help usage. Tiles show Total views, Unique articles, Total searches, Article feedback, Chat queries and Chat feedback for the chosen Range.',
      'Use the tabs Popular articles, Search gaps (searches with no results, which point to missing docs), Article feedback, Article comments, Recent questions and Chat feedback.',
      'In Chat feedback, click View on a row to read the conversation and its rating.',
    ],
    keywords: ['help analytics', 'unanswered questions', 'docs usage', 'search gaps', 'help chat', 'article feedback'],
  },
  {
    id: 'team-directory',
    title: 'Team',
    summary:
      'An internal contact directory of team members with phone, email, role and department, shown as cards sorted by name.',
    views: ['admin.team'],
    settings: [],
    howTo: [
      'Open Team. Click Create team member and enter Name and Phone (required), plus optional Email, Role and Department.',
      'Use the Edit member icon on a card to change details, or Remove member to delete the entry.',
    ],
    keywords: ['staff', 'contacts', 'directory', 'phone numbers', 'team members'],
  },
  {
    id: 'world-time',
    title: 'World time',
    summary:
      'Shows the current local time, date and offset for a set of cities, with favorites sorted first, for coordinating across time zones.',
    views: ['admin.world_time'],
    settings: [],
    howTo: [
      'Open World time to see a card per city.',
      'Click Add location and search for a city to add it.',
      'Use the favorite icon on a card to pin it to the front, or the remove icon to delete it.',
    ],
    keywords: ['time zones', 'clocks', 'utc', 'local time', 'international time'],
  },
  {
    id: 'documentation-browser',
    title: 'Documentation',
    summary:
      'A searchable card grid of the platform documentation, filterable by category, with a link to open each article on the docs site.',
    views: ['admin.documentation'],
    settings: [],
    howTo: [
      'Open Documentation and type in the search bar to filter by title, description or tag.',
      'Click a category chip such as Admin Settings, Architecture or Security to narrow the list; All clears the filter.',
      'Click Open in Docusaurus on a card to read the full article, or Refresh to reload the list.',
    ],
    keywords: ['docs', 'guides', 'reference', 'help docs', 'internal docs', 'docusaurus'],
  },
  {
    id: 'api-reference',
    title: 'API reference',
    summary:
      'The public REST API reference inside the admin area, with interactive docs, an auth and unmigrated endpoints view, a Claude Code quickstart and a downloadable OpenAPI spec.',
    views: ['admin.api_reference'],
    settings: [],
    howTo: [
      'Open API reference and choose a view: Interactive Docs, Auth & Unmigrated Endpoints or Claude Code Quickstart.',
      'Click Open in New Tab for the full docs page, or Download OpenAPI Spec to save the spec file.',
    ],
    keywords: ['openapi', 'rest api', 'endpoints', 'api docs', 'swagger', 'api scopes'],
  },
  {
    id: 'api-cookbook',
    title: 'API cookbook',
    summary:
      'A list of practical recipes for working with the API, each with a difficulty chip and code you can follow step by step.',
    views: ['admin.api_cookbook'],
    settings: [],
    howTo: ['Open API cookbook and click a recipe to read it.', 'Click Back to recipes to return to the list.'],
    keywords: ['recipes', 'examples', 'code samples', 'api guide', 'how to call api'],
  },
  {
    id: 'architecture-diagrams',
    title: 'Architecture',
    summary:
      'System architecture diagrams of the platform, covering the user prompt journey, infrastructure, the retrieval pipeline and the security architecture.',
    views: ['admin.architecture'],
    settings: [],
    howTo: [
      'Open Architecture and pick a tab: User Prompt Journey, Infrastructure Overview, RAG Pipeline or Security Architecture.',
    ],
    keywords: ['diagrams', 'system design', 'data flow', 'infrastructure', 'rag pipeline', 'prompt flow'],
  },
  {
    id: 'dependencies',
    title: 'Dependencies',
    summary:
      "An overview of the platform's software packages and service dependencies, with versions, which part uses each and a category.",
    views: ['admin.dependencies'],
    settings: [],
    howTo: [
      'Open Dependencies to see Dependency Categories with their key dependencies.',
      'Scan the table of Package, Version, Used By and Category, and the Dependency Flow section, to see what the platform relies on.',
    ],
    keywords: ['packages', 'libraries', 'versions', 'third-party services', 'tech stack'],
  },
];
