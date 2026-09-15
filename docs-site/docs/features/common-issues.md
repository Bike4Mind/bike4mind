---
title: Common Issues & Solutions
description: Troubleshooting guide for the most common problems with Bike4Mind — login, credits, AI models, organization permissions, and Slack integration.
sidebar_position: 90
tags: [troubleshooting, faq, help, common-issues]
---

# Common Issues & Solutions

Quick answers to the most common questions and problems. Click any item to expand.

## Login & Authentication

<details>
<summary>I can't log in to my account</summary>

**Check these common causes first:**

1. **Wrong email address** — Ensure you're using the exact email address tied to your Bike4Mind account.
2. **Use the correct sign-in method** — If your organization uses Google SSO, Microsoft, or another identity provider, use that button on the login page rather than the email form.
3. **Check your inbox for the one-time code** — After entering your email, a one-time code (OTC) is sent to that address. Check your spam/junk folder if it hasn't arrived within a few minutes.
4. **Clear browser cache** — Go to your browser settings, clear cookies and cached data for this site, then try again.

If you still can't log in, contact your organization admin to verify your account email is correct and your account is active.

</details>

<details>
<summary>My session keeps expiring / I keep getting logged out</summary>

Sessions expire after a period of inactivity for security. To reduce interruptions:

- **Stay active** — Bike4Mind keeps sessions alive while you're working. Background tabs may not send activity signals.
- **Check cookie settings** — Aggressive cookie-clearing in your browser will end sessions when you close the tab.
- **Disable conflicting extensions** — Ad blockers and privacy extensions can interfere with session cookies.

If you're being logged out mid-session (not just after long inactivity), contact support — this may indicate a session storage issue that an admin can investigate.

</details>

<details>
<summary>SSO / identity provider login isn't working</summary>

If your organization uses single sign-on (Google Workspace, Microsoft Entra, Okta, etc.):

1. **Confirm your identity provider account is active** — Verify you can sign in to Google/Microsoft/Okta directly before assuming the issue is with Bike4Mind.
2. **Use the SSO button, not the email/password form** — Entering your SSO email in the password field will fail.
3. **Contact your IT or admin team** — SSO is configured at the organization level. If SSO is broken for your whole team, your admin needs to check the identity provider connection under **Admin → Security → Identity Providers**.

</details>

<details>
<summary>I'm not receiving the login code email</summary>

1. **Check your spam/junk folder** — One-time code emails are sometimes filtered.
2. **Wait a few minutes** — Email delivery can take up to 5 minutes.
3. **Confirm the right email** — The code is sent to the email registered on your account.
4. **Request a fresh code** — Codes expire after a short window. If too much time has passed, go back to the login page and submit a new request.

If the issue persists, contact your organization admin to confirm your account email is correct.

</details>

---

## Credits & Billing

<details>
<summary>What are credits and how do they work?</summary>

Credits are the currency used to run AI operations on Bike4Mind. Each message, image generation, Smart Tool use, or Subagent run consumes credits based on the cost of the underlying AI model.

- **More powerful models cost more** — GPT-4o, Claude Opus, and Gemini Ultra use significantly more credits per message than smaller models like GPT-4o Mini or Claude Haiku.
- **Longer conversations cost more** — The full conversation history is sent to the model on every turn, so credit cost grows as a conversation gets longer.
- **Tools and subagents each consume credits** — Web search, image generation, and Subagents each bill independently.

Monitor your balance by clicking your avatar in the sidebar and selecting **Credits**, or under **Profile → Settings → Billing**.

</details>

<details>
<summary>How do I check my credit balance?</summary>

1. Click your avatar in the bottom-left of the sidebar.
2. Select **Credits** to open your credit summary.

For a detailed breakdown, go to **Profile → Settings → Billing**.

Organization admins can view credit usage across all members under **Admin → User Ops → Credit Analytics**.

</details>

<details>
<summary>Why did my credits decrease more than I expected?</summary>

Common reasons for higher-than-expected usage:

- **High-cost model selected** — Switching to a premium model dramatically increases per-message cost.
- **Long conversation context** — As a conversation grows, each new message carries the full history, multiplying token usage.
- **Active Smart Tools** — Web search, image generation, and other tools each add to the tally.
- **Subagents** — QuestMaster and other workflows that spawn subagents bill each agent call independently.

Review your usage breakdown under **Profile → Settings → Billing**. If you believe a charge was in error, contact support.

</details>

<details>
<summary>How do I get more credits?</summary>

- **Individual users**: Ask your organization admin — they can allocate credits to your account from **Admin → Users**.
- **Organization admins**: Manage your credit pool and top-up options in **Admin → Subscriptions**.
- **Billing questions**: Reach out to support at support@bike4mind.com.

</details>

---

## AI Model Errors

<details>
<summary>I'm seeing "Model unavailable" or a model won't load</summary>

This typically has one of three causes:

1. **Provider outage** — OpenAI, Anthropic, and Google occasionally have incidents. Check the relevant provider's status page.
2. **Model not enabled for your organization** — Some models require an admin to enable them under **Admin → AI & Agents → LLM Dashboard**. Contact your admin if you think a model should be available to you.
3. **Rate limit hit** — High-traffic periods can trigger per-minute rate limits. Wait 60 seconds and retry.

**Workaround**: Switch to a different model from the selector in the chat toolbar while the issue resolves.

</details>

<details>
<summary>The AI response was cut off mid-sentence</summary>

Responses can be truncated when:

- **The max token limit is reached** — Raise the **Max Tokens** setting in the chat toolbar or notebook settings if you need longer responses.
- **A network interruption** — An unstable connection can cut off a response mid-flight. Refresh and try again.
- **The model self-truncated on a very long output** — Ask the model to "continue" or break your request into smaller parts.

</details>

<details>
<summary>The AI refused my request or returned an error</summary>

- **Content policy refusal** — Rephrase your request to make the legitimate use case clear. Specific, professional context often resolves false positives.
- **Temporary server error** — Wait a moment and retry. If the error persists for more than a few minutes, the AI provider may be experiencing an outage.
- **Conversation too long** — Very long conversations can exceed a model's memory limit. Start a fresh conversation, or ask the AI to summarize the history to compress it.

</details>

<details>
<summary>Responses are very slow</summary>

Speed depends on the model and current provider load:

- **Switch to a faster model** — GPT-4o Mini and Claude Haiku are significantly faster than their flagship counterparts.
- **Shorten the conversation** — Less history means fewer tokens per request and faster streaming.
- **Check provider status** — Slowdowns during peak usage are common across all providers.
- **Check your connection** — VPNs and proxies can add latency to streaming responses.

</details>

---

## Organization & Team Permissions

<details>
<summary>I can't access a feature that others on my team can use</summary>

Feature access is controlled by your role within the organization:

- **Member** — Core AI features, notebooks, and quests.
- **Manager** — Everything a Member can do, plus team management and shared resource administration.
- **Admin** — Full access including the Admin Dashboard, user management, billing, and model configuration.

If you believe you should have access to something you don't, ask your admin to review your role under **Admin → Users**.

</details>

<details>
<summary>I can't see my team's shared notebooks or projects</summary>

1. **Confirm you're in the right organization** — If you belong to multiple organizations, use the organization switcher (bottom of the left sidebar) to select the correct one.
2. **Verify your team membership** — Shared notebooks are visible based on team membership. Ask your admin to add you to the relevant team under **Admin → Organizations**.
3. **Check the notebook's share settings** — The notebook owner may have shared it with a specific team, not the entire organization.

</details>

<details>
<summary>I'm trying to invite a user but getting an error</summary>

- **Check your role** — Only Admins and Managers can send invitations.
- **Confirm the email isn't already in use** — If the user already has a Bike4Mind account under another organization, contact support to resolve the conflict.
- **Check your seat limit** — Your subscription plan may have a user cap. Review available seats under **Admin → Subscriptions**.

</details>

---

## Slack Integration

<details>
<summary>The Bike4Mind bot isn't responding in Slack</summary>

1. **Verify the bot is installed** — In Slack, go to **Apps** and confirm Bike4Mind is listed. If not, an admin needs to connect it under **Admin → Integrations → Slack Workspaces**.
2. **Add the bot to the channel** — The bot only responds in channels it has been invited to. Type `/invite @Bike4Mind` in the channel to add it.
3. **Check the connection status** — In Bike4Mind, go to **Admin → Integrations** and confirm the Slack workspace shows as **Connected**.

</details>

<details>
<summary>How do I set up the Slack integration for my organization?</summary>

1. Log in to Bike4Mind as an **Admin**.
2. Navigate to **Admin → Integrations → Slack Workspaces**.
3. Click the **+** (Create Slack App) button to set up a new workspace configuration.
4. Follow the on-screen steps to create and install the bot in your Slack workspace.
5. Once the workspace shows as installed, invite the bot to any channels where you want it available (`/invite @Bike4Mind`).
6. Users can interact with the bot via direct message or by @mentioning it in a connected channel.

Each Slack workspace must be configured separately if your organization uses more than one.

</details>

<details>
<summary>Slack notifications aren't coming through</summary>

- **Check Slack notification settings** — Confirm you haven't muted the channel or the bot's DMs.
- **Review notification preferences in Bike4Mind** — Go to **Profile → Settings → General** and verify Slack notifications are enabled.
- **Re-authorize the integration** — The Slack connection can expire over time. An admin can reconnect the workspace under **Admin → Integrations → Slack Workspaces**.

</details>

<details>
<summary>The bot is connected but using the wrong AI model</summary>

Admins can configure which AI model the Slack bot uses — per channel or workspace-wide — from the workspace settings in **Admin → Integrations → Slack Workspaces**. If the bot is using an unexpected model, ask your admin to update those settings.

</details>
