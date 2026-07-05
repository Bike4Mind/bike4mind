---
title: GitHub Slack Notifications
description: Get GitHub activity notifications delivered as Slack DMs
sidebar_position: 13
tags: [github, slack, notifications, integration, webhooks]
---

# GitHub Slack Notifications

Get notified in Slack when important things happen on your GitHub repositories — PR reviews, CI failures, @mentions, push commits, and more. Notifications are delivered as direct messages from the Bike4Mind bot.

## What You'll Get

### Pull Request Notifications

| Notification | When It Triggers | Who Gets Notified |
|---|---|---|
| PR Opened | A new pull request is opened | Requested reviewers |
| Review Requested | Your review is requested on a PR | The requested reviewer |
| PR Approved | Your pull request is approved | PR author |
| Changes Requested | A reviewer requests changes on your PR | PR author |
| PR Merged | Your pull request is merged | PR author |
| PR Review Comment | Someone comments on your PR's code | PR author, @mentioned users |

### CI/CD Notifications

| Notification | When It Triggers | Who Gets Notified |
|---|---|---|
| CI Failed | A GitHub Actions workflow fails | The person who triggered it |
| CI Passed | A GitHub Actions workflow succeeds (opt-in) | The person who triggered it |

### Code & Issue Notifications

| Notification | When It Triggers | Who Gets Notified |
|---|---|---|
| Push Commits | Commits pushed to protected branches (main, master, develop, release/*) | Subscribers (except the pusher) |
| Issue Opened | A new issue is opened | Assignees + subscribers (except the author) |
| Issue Closed | An issue is closed | Issue author (if closed by someone else) |
| Issue Assigned | You're assigned to an issue | The assignee |
| @Mentions | Someone @mentions you in a comment | The mentioned user |

:::tip Push Notifications are Opt-In
Push commit notifications must be explicitly enabled in your subscription events filter to avoid notification overload from high-activity repos.
:::

---

## For Organization Admins

Organization admins configure a single webhook URL that covers the entire team. Team members then subscribe individually.

### Step 1: Create the Organization Webhook

1. Go to your **Organization** page in Bike4Mind
2. Click the **Webhooks** tab
3. Click **Create Webhook**
4. You'll see:
   - **Webhook URL** — Copy this to add to GitHub
   - **Secret** — Shown once when created. Copy and save it securely.

:::caution Save Your Secret
The webhook secret is only displayed once when created. If you lose it, you'll need to rotate (regenerate) it from the Webhooks tab.
:::

### Step 2: Add the Webhook to GitHub

Add the webhook at the **GitHub organization level** for automatic coverage of all repositories:

1. Go to your GitHub organization **Settings** → **Webhooks** → **Add webhook**
2. Configure the webhook:
   - **Payload URL**: Paste the webhook URL from Step 1
   - **Content type**: Select `application/json`
   - **Secret**: Paste the secret from Step 1
3. Under **Which events would you like to trigger this webhook?**, select **Let me select individual events** and check:
   - **Pull requests** — PR opened, merged
   - **Pull request reviews** — Approvals, changes requested
   - **Pull request review comments** — Code review comments
   - **Issues** — Issue opened, closed, assigned
   - **Issue comments** — @mentions in issue comments
   - **Pushes** — Commits pushed to branches
   - **Workflow runs** — CI/CD pass/fail notifications
4. Click **Add webhook**

GitHub will send a ping event. A green checkmark indicates success.

:::tip Organization vs Repository Webhooks
- **Organization-level webhook** (recommended): Covers all current and future repos automatically
- **Repository-level webhook**: Only covers that specific repo

For organization webhooks, go to: `github.com/orgs/YOUR-ORG/settings/hooks`
:::

### Step 3: Verify the Webhook

After adding the webhook to GitHub:

1. Return to your Bike4Mind **Organization** → **Webhooks** tab
2. Look for the **Last Delivery** timestamp to confirm events are being received
3. Try creating a test PR or pushing a commit to verify notifications flow through

### Managing the Webhook

#### Rotating the Secret

If you need to regenerate the webhook secret (e.g., if it was exposed):

1. Go to **Organization** → **Webhooks** tab
2. Click **Rotate Secret**
3. Copy the new secret and update it in GitHub's webhook settings

#### Disabling the Webhook

Toggle the **Enabled** switch off to temporarily stop all webhook processing without deleting the configuration.

---

## For Team Members (Subscribers)

Each team member opts in to receive notifications by subscribing to the organization webhook.

### Step 1: Connect Your Slack Account

1. Go to **Settings** → **Integrations** → **Slack Integration**
2. Enter your **Slack Member ID** and save

:::info Finding Your Slack Member ID
In Slack, click your profile picture → **Profile** → click the **three dots** (more actions) → **Copy member ID**.
:::

### Step 2: Set Your GitHub Username

1. Go to **Settings** → **Integrations** → **GitHub Integration**
2. Enter your **GitHub username** exactly as it appears on GitHub (case-insensitive)
3. Save

This maps your GitHub activity to your Slack account. Without this, notifications can't find you.

### Step 3: Subscribe to the Organization

1. Go to **Settings** → **Integrations** → **GitHub Webhook Subscriptions**
2. Click **Subscribe to Organization**
3. Select your organization from the dropdown
4. Click **Subscribe**

Your subscription defaults to **all repos** and **all events** except push notifications (which are opt-in).

### Step 4: Configure Your Notification Preferences

In **Settings** → **Integrations** → **GitHub Integration**, toggle which notifications you want:

**Pull Request Events:**
- **PR Opened** — When someone opens a PR and requests your review
- **Review Requested** — When your review is specifically requested
- **PR Approved** — When your PR gets approved
- **Changes Requested** — When a reviewer requests changes on your PR
- **PR Merged** — When your PR is merged
- **PR Review Comment** — When someone comments on your PR's code

**CI/CD Events:**
- **CI Failed** — When a workflow run fails for your push
- **CI Passed** — When a workflow run succeeds (disabled by default — can be noisy)

**Code & Issue Events:**
- **Push Commits** — When commits are pushed to protected branches (opt-in)
- **Issue Opened** — When someone opens an issue in a repo you're subscribed to
- **Issue Closed** — When an issue you created is closed
- **Issue Assigned** — When you're assigned to an issue
- **@Mentions** — When someone @mentions your GitHub username

---

## Understanding Your Delivery History

Each subscription has a delivery history showing all webhook events. Access it by clicking the history icon next to your subscription.

### Delivery Statuses

| Status | Meaning |
|--------|---------|
| **Success** | You were a notification target and received a Slack message |
| **Skipped** | You weren't a notification target for this event (see below) |
| **Failed** | Delivery attempted but failed (Slack error, rate limit, etc.) |
| **Pending** | Delivery is queued and will be attempted shortly |

### Why Events Show "Skipped"

**"Skipped"** is normal and expected. It means the event was processed, but you weren't the intended recipient. Common reasons:

| Event Type | Why You See "Skipped" |
|------------|----------------------|
| PR Opened | You weren't a requested reviewer |
| PR Approved/Changes | You're not the PR author |
| CI Failed/Passed | You didn't trigger the workflow |
| Push Commits | You were the pusher (no self-notification) |
| Issue Events | You're not the author, assignee, or mentioned |
| PR Review Comment | You're not the PR author and weren't @mentioned |

**Self-notification prevention:** You won't receive notifications for your own actions. If you open a PR, approve a review, or push commits, you already know — so no notification is sent.

### Example Scenario

You subscribe to an organization. A coworker opens a PR requesting your review:

1. **Your coworker** (PR author) → Sees "skipped" for the `pull_request.opened` event (authors don't get notified for their own PRs)
2. **You** (requested reviewer) → See "success" and receive a Slack DM

---

## Managing Your Subscription

### Pausing Notifications

Temporarily pause notifications without unsubscribing:

1. Go to **Settings** → **Integrations** → **GitHub Webhook Subscriptions**
2. Toggle the **Enabled** switch off for your subscription

### Filtering Events

You can limit which event types you receive. In your subscription settings, select specific events instead of "all events."

### Unsubscribing

1. Go to **Settings** → **Integrations** → **GitHub Webhook Subscriptions**
2. Click the **delete** icon next to your subscription
3. Confirm

### Auto-Disable (Circuit Breaker)

If notifications fail to deliver 10 times consecutively (e.g., Slack connection issues), your subscription is automatically disabled. You'll see an **"Auto-disabled"** status with a **Re-enable** button once the issue is resolved.

---

## Troubleshooting

### Not Receiving Notifications

Check these in order:

1. **Org webhook enabled?** Organization page → Webhooks tab → Enabled toggle must be ON
2. **Subscription enabled?** Settings → Integrations → Webhook Subscriptions → Enabled toggle must be ON
3. **GitHub username correct?** Settings → Integrations → GitHub Integration → Must match your GitHub username exactly
4. **Notification toggles on?** Same section → Toggle must be ON for the event type you expect
5. **Slack connected?** Settings → Integrations → Slack Integration → Slack Member ID must be set
6. **Are you the target?** Check delivery history — "skipped" means you weren't the intended recipient

### All Events Show "Skipped"

This usually means one of:

- **GitHub username mismatch** — Your configured username doesn't match how GitHub identifies you in webhooks
- **Self-notification** — You're seeing events you triggered yourself
- **Not a notification target** — The events are for other team members (PR reviews for different PRs, etc.)

### Rate Limited

There's a limit of **100 notifications per user per day** to prevent spam from high-activity repos. The counter resets at midnight. If you're hitting this limit, consider:

- Disabling noisy notifications (CI Passed, Push Commits)
- Filtering to specific repositories

### Webhook Secret Mismatch

If GitHub shows delivery failures with "signature mismatch":

1. Verify the secret in GitHub matches the one in Bike4Mind
2. If lost, rotate the secret in Bike4Mind and update GitHub

---

## FAQ

**Q: Can I get notifications from multiple organizations?**

Yes. Subscribe to each organization separately in the Webhook Subscriptions section.

**Q: Who can see the webhook secret?**

Only organization admins and managers. The secret is encrypted at rest and masked in the UI.

**Q: Why don't I get notified when I open my own PR?**

By design. Self-notification is disabled because you already know about actions you performed.

**Q: Can I choose which repos I get notifications for?**

Your subscription defaults to all repos. Repository filtering will be available in a future update.

**Q: What branches trigger push notifications?**

Only protected branches: `main`, `master`, `develop`, and `release/*` patterns. Feature branches are excluded to reduce noise.

**Q: Why are CI events "skipped" when CI passed?**

Check if you have **CI Passed** enabled in your notification preferences. It's disabled by default because successful CI runs are frequent and can be noisy.

---

## Related Features

- [Slack Multi-Workspace OAuth](./slack-multi-workspace-oauth.md) — Connect Slack workspaces to Bike4Mind
- [Organization Slack Integration](./org-slack-self-service.md) — Org-level Slack workspace setup
- [Slack AI Model Configuration](./slack-model-config.md) — Configure AI models per channel and org
- [Organizations & Teams](./organizations-teams.md) — Manage your organization
