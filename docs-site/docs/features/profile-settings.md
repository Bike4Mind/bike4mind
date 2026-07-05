---
title: Profile & Settings
description: Manage your account, preferences, security, and integrations
sidebar_position: 5
tags: [profile, settings, account, security, integrations]
---

# Profile & Settings

Your profile page is your central hub for account management, preferences, security settings, and external integrations.

Access your profile by clicking your avatar in the sidebar footer.

---

## Profile Tab

### Account Information

View and edit your basic profile:
- **Avatar** - Upload a profile picture
- **Name** - Your display name
- **Email** - Primary email (change with verification)
- **Phone** - Contact number (optional)
- **Location** - Your location (optional)

### Subscription & Credits

- **Current Plan** - View your subscription tier
- **Renewal Date** - When your subscription renews
- **Credit Balance** - Available AI credits
- **Storage Used** - File storage consumption

**Actions:**
- Purchase additional credits
- Manage subscription (opens Stripe portal)
- View pricing plans

---

## Community Tab

Connect with other Bike4Mind users.

### Friend Requests

- View pending friend requests
- Accept or decline requests
- See notification count in sidebar

### Friends List

- View your connections
- Visit friend profiles
- Remove friends

### Adding Friends

1. Visit a user's public profile
2. Click **Add Friend**
3. Wait for them to accept

---

## Settings Tab

### Preferences

| Setting | Description |
|---------|-------------|
| **Language** | Select your preferred language |
| **Help Interface** | Show/hide help tooltips |
| **Voice** | Text-to-speech preferences |

### Experimental Features

Bike4Mind offers several cutting-edge features that are opt-in. **You must enable each feature here before it appears in your sidebar or UI.** For example, if you don't see "Agents" in your left navigation, it's because the Agents toggle hasn't been turned on yet.

> **Note:** Some experimental features may need to be enabled at the organization level by an admin before they appear as toggles on this page. If you don't see a feature listed below, contact your organization admin.

| Feature | What It Does | What Enabling It Adds |
|---------|-------------|----------------------|
| **[Quest Master](./quest-master.md)** | AI-powered autonomous task planning and execution | Quest Master option in AI Settings |
| **[Mementos](./mementos.md)** | AI memory system that remembers context across sessions | Mementos tab in Profile, memory recall in conversations |
| **[Artifacts](./artifacts-system.md)** | Rich interactive outputs like React components, diagrams, and code | Artifact rendering in conversations |
| **[Agents](./agents.md)** | Custom AI assistants with unique personalities and expertise | **"Agents" in the left sidebar**, agent @mention support |
| **[Research Mode](./research-mode.md)** | Compare responses from multiple AI models side-by-side | Research Mode option in notebook AI Settings |
| **[Rapid Reply](./rapid-reply.md)** | Get instant acknowledgments from fast mini models while your full response is being prepared | Quick-reply indicators in chat |
| **[Private Model Hub](./private-model-hub.md)** | Access privately hosted cutting-edge models including DeepSeek, Qwen, and other frontier models | Additional models in model selector |
| **[Research Engine](./research-engine.md)** | Search the web for information during AI conversations | Web search and deep research tools in chat |
| **[B4M Pi](./b4m-pi.md)** | Repository analysis, task scheduling, Gantt charts, and team activity dashboards | **B4M Pi in the sidebar**, full project intelligence dashboard |
| **OptiHashi** | AI-driven optimization across advanced solvers | **OptiHashi in the sidebar**, optimization dashboard and chat tools |
| **[Lattice](./lattice.md)** | Create and manipulate financial pro-forma models using natural language | Lattice model artifacts in notebooks |

### Data Management

**Import Options:**
- Import notebooks from files
- Import chat history from OpenAI or Claude

**Export Options:**
- Export notebooks individually or in bulk
- Download all knowledge files as ZIP

**Danger Zone:**
- Delete all sessions (irreversible)
- Delete all files (irreversible)

---

## Security Tab

### Security Overview

See your account's security status at a glance:
- **Security Score** - AI-assessed risk level
- **Threat Level** - Low/Medium/High indicator
- **Recommendations** - Steps to improve security

### Security Metrics

Monitor security-relevant activity:
- Suspicious login attempts
- Failed logins (last 24 hours)
- API key status
- Phishing test results

### Multi-Factor Authentication (MFA)

Protect your account with two-factor authentication:

**Setting Up MFA:**
1. Click **Enable MFA**
2. Scan QR code with authenticator app (Google Authenticator, Authy, etc.)
3. Enter verification code
4. Save backup codes securely

**Backup Codes:**
- Generate emergency access codes
- Use if you lose your authenticator
- Regenerate codes anytime

### Blocked IPs

View and manage automatically blocked IP addresses:
- See block reason and timestamp
- Unblock IPs if needed

### Recent Activity

Review security events:
- Failed login attempts
- Suspicious patterns
- API key alerts

---

## Integrations Tab

Connect external services to enhance your workflow.

### Connected Apps

| Service | Features |
|---------|----------|
| **Google Drive** | Import files directly from Drive |
| **Okta** | Single sign-on authentication |
| **Atlassian (Jira & Confluence)** | Jira issue tracking and Confluence page search in chat |

### Atlassian Integration (Jira & Confluence)

Connect your Atlassian account to use Jira and Confluence tools directly in your AI chat sessions.

**Connecting:**
1. In the Connected Apps section, find **Atlassian (Jira, Confluence)**
2. Click **Link** to start the OAuth authorization flow
3. You'll be redirected to Atlassian to grant access
4. After authorization, you'll be returned to Bike4Mind with a confirmation

**Connection Status:**
- **Connected** (green) — Active connection with your Atlassian site name displayed
- **Needs Reconnect** (yellow) — OAuth token has expired. Click **Reconnect** to re-authorize
- **Not Connected** — Click **Link** to connect

**What You Get After Connecting:**

Once linked, Jira and Confluence tools become available as [Smart Tools](./smart-tools.md) in your chat notebooks:
- Search and view Jira issues from your connected projects
- Create and update Jira tickets through conversation
- Search Confluence pages for documentation and reference material
- Reference project context without leaving your notebook

If a tool reports that your connection has expired, return to Connected Apps and click **Reconnect**.

**Jira Webhook Notifications:**

You can also configure Jira event notifications to be delivered to a Slack channel:

1. Click **Enable Notifications** in the Jira Notifications section
2. Copy the provided **Webhook URL** and **Secret**
3. In your Jira admin panel, navigate to **Settings > System > Webhooks (under Advanced) > Create a webhook**
4. Paste the URL and secret, then select which Jira events to send

After setup, you can customize:
- **Slack Channel** — Specify a channel ID, or leave blank to receive DMs
- **Project Keys Filter** — Limit to specific Jira projects (e.g., "PROJ, ENG")
- **Priority Filter** — Filter by issue priority (Highest, High, Medium, Low, Lowest)

**Disconnecting:**

Click **Unlink** to revoke the Atlassian connection. Your Jira notification configuration will be preserved but inactive until you reconnect.

### Slack Integration

Connect your Slack workspace:

**Features:**
- Create notebooks from Slack messages
- Route messages to agents using @mentions
- Configure keyword-based routing
- Set default notebook/project

**Agent Mentions:**
- `@dev` - Developer agent
- `@pm` - Product manager agent
- `@analyst` - Analyst agent
- `@researcher` - Research agent
- `@agent` - Custom agent (configurable)

### GitHub Integration

Connect GitHub for:
- Repository references and code search in chat
- Issue tracking and pull request tools
- Activity data for [B4M Pi](./b4m-pi.md) project intelligence dashboards

### Webhooks

Configure outgoing webhooks for:
- Custom integrations
- Automation workflows
- Third-party services

### MCP Servers

Connect Model Context Protocol servers for:
- Extended AI capabilities
- Custom tool integrations
- External data sources

---

## API Keys Tab

Create and manage API keys for programmatic access.

### Creating API Keys

1. Click **Create API Key**
2. Name your key (e.g., "Production App")
3. Select scopes (permissions)
4. Set rate limits
5. Choose expiration

### Available Scopes

| Scope | Permission |
|-------|------------|
| `READ_NOTEBOOKS` | View notebooks and sessions |
| `WRITE_NOTEBOOKS` | Create/modify notebooks |
| `READ_FILES` | Download and view files |
| `WRITE_FILES` | Upload and modify files |
| `AI_GENERATE` | AI generation features |
| `AI_CHAT` | AI chat features |
| `READ_PROJECTS` | View projects |
| `WRITE_PROJECTS` | Create/modify projects |

### Rate Limiting

Set limits to control usage:
- Requests per minute
- Requests per day

### Key Management

- **Rotate** - Generate new secret (invalidates old)
- **Revoke** - Permanently disable key
- **View usage** - See last used timestamp

### API Documentation

The API Keys section includes:
- Quick start guide
- Endpoint reference
- Code examples (cURL, JavaScript, Python)

---

## System Prompts Tab

Manage custom AI instructions that apply across your sessions.

### What Are System Prompts?

System prompts are instructions given to AI before your conversations. They define:
- AI personality and tone
- Domain-specific knowledge
- Response guidelines
- Behavioral constraints

### Managing System Prompts

- **Upload** - Add new prompt files
- **Enable/Disable** - Toggle prompts without deleting
- **Delete** - Remove prompts permanently
- **Search** - Find prompts by name

---

## Mementos Tab

*(Experimental Feature)*

View and manage your AI memory entries:
- See what the AI remembers about you
- Delete specific memories
- Review memory categories

---

## Credit Analytics Tab

Understand your AI usage patterns.

### Usage Overview

- **Total credits used** - Cumulative consumption
- **Burn rate** - Average daily usage
- **Days remaining** - Estimated time until credits run out

### Time Periods

View analytics for:
- Last 7 days
- Last 30 days
- Last 90 days
- Last 180 days

### Model Breakdown

See which AI models consume most credits:
- Per-model usage charts
- Cost comparison
- Usage trends

### Transaction History

Review credit transactions:
- Purchases
- Usage by date
- Model attribution

---

## Email Inbox Tab

Manage email-to-notebook functionality.

### How It Works

1. Forward emails to your Bike4Mind inbox address
2. Emails are converted to notebook entries
3. Ask AI questions about email content

### Features

- View ingested emails
- See email-based notebook history
- Manage forwarding settings

---

## Tips & Best Practices

### Security

1. **Enable MFA** - Significantly improves account security
2. **Use strong passwords** - Unique, complex passwords
3. **Review activity** - Check security tab regularly
4. **Rotate API keys** - Periodically refresh keys

### Integrations

1. **Start simple** - Add integrations as needed
2. **Configure routing** - Set up Slack routing for efficiency
3. **Test webhooks** - Verify before production use

### Data Management

1. **Export regularly** - Back up important notebooks
2. **Clean up** - Remove unused sessions and files
3. **Monitor storage** - Stay within limits

---

## Related Features

- [Organizations & Teams](./organizations-teams.md) - Team settings
- [Notebooks](./notebooks.md) - Where settings apply
- [Smart Tools](./smart-tools.md) - Tools available in your notebooks
- [AI Models](./ai-models.md) - Model selection and availability
- [Agents](./agents.md) - Custom AI assistants
- [Quest Master](./quest-master.md) - Autonomous task planning
- OptiHashi - Optimization engine
- [B4M Pi](./b4m-pi.md) - Project intelligence
