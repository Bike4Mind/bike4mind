---
title: Integration Troubleshooting
description: Diagnose and resolve common issues across GitHub, Slack, Jira, and Confluence integrations
sidebar_position: 99
tags: [troubleshooting, integrations, github, slack, jira, confluence, webhooks]
---

# Integration Troubleshooting

This guide covers common issues and solutions across all Bike4Mind integrations. Use the quick diagnosis section to identify your problem, then jump to the relevant section.

## Quick Diagnosis

**What best describes your issue?**

| Symptom | Likely Cause | Jump To |
|---|---|---|
| "Unauthorized" or "Token expired" | OAuth token expired or revoked | [Authentication Issues](#authentication-issues) |
| Agent says "not connected" | Integration not set up | [Connection Issues](#connection-issues) |
| Webhook not delivering events | Signature, URL, or circuit breaker | [Webhook Issues](#webhook-issues) |
| "Rate limit exceeded" / 429 error | Too many API calls | [Rate Limit Issues](#rate-limit-issues) |
| "Permission denied" / 403 error | Insufficient access on external service | [Permission Issues](#permission-issues) |
| Slack bot doesn't respond | Bot not in channel or scopes missing | [Slack Issues](#slack) |
| Tool returns unexpected error | API or configuration problem | [Per-Integration Sections](#github) |

## Authentication Issues

Authentication problems are the most common integration issue. All integrations use OAuth tokens that can expire or be revoked.

### Token Expired

**Symptoms:** `401 Unauthorized` errors, agent says "token expired"

**Resolution:**
1. Navigate to **Profile → Integrations**
2. Find the affected integration
3. Click **Disconnect**, then **Reconnect**
4. Re-authorize on the external service

:::info Automatic Token Refresh
Atlassian tokens (Jira/Confluence) are automatically refreshed before expiration. If automatic refresh fails, you'll need to reconnect manually.
:::

### Token Revoked

**Symptoms:** `401 Unauthorized` after changing password or revoking app access

**Resolution:** Same as token expired — disconnect and reconnect in Profile → Integrations.

### OAuth Flow Fails

**Symptoms:** Redirect to error page during connection, "state parameter invalid"

**Resolution:**
1. Clear browser cookies for Bike4Mind
2. Ensure you're logged in to the correct Bike4Mind account
3. Try connecting again
4. If the issue persists, the OAuth state token may have expired (10-minute validity) — restart the flow

## Connection Issues

### Integration Not Appearing

**Symptoms:** No option to connect an integration

**Resolution:** Ask your organization admin to enable the integration in **Admin Settings → Integrations**.

### Atlassian Site Selection

**Symptoms:** Connected but no Jira/Confluence data available, "site not found"

**Resolution:**
1. You may have selected the wrong Atlassian site
2. Disconnect Atlassian in Profile → Integrations
3. Reconnect and carefully select the correct site
4. If you only have one site, it's auto-selected

## Webhook Issues {#webhooks}

### Webhook Not Receiving Events

**Possible causes:**

| Cause | Check | Fix |
|---|---|---|
| Wrong URL | Verify URL in GitHub/Jira webhook settings | Copy URL from Bike4Mind webhook config |
| Webhook disabled | Check status in external service | Re-enable the webhook |
| Events not selected | Check subscribed events in external service | Add missing events |
| Network/firewall | Check if external service can reach your URL | Verify URL is publicly accessible |

### Invalid Signature

**Symptoms:** `401` responses on webhook deliveries, "signature mismatch" in delivery logs

**Resolution:**
1. Verify the webhook secret in the external service matches the one in Bike4Mind
2. If you recently rotated the secret, ensure you updated it in the external service within 24 hours
3. If the secret was lost, rotate it in Bike4Mind and update the external service

:::warning Secret Mismatch
If the secret in the external service doesn't match Bike4Mind, **all** webhook deliveries will fail. This is the most common webhook issue.
:::

### Subscription Auto-Disabled

**Symptoms:** No notifications received, subscription shows as "disabled" in settings

**Cause:** Circuit breaker triggered after consecutive delivery failures.

**Resolution:**
1. Check the failure reason in the delivery history:
   - **Slack channel deleted** → Update subscription to a valid channel
   - **Bot removed from channel** → Re-invite the bot: `/invite @Bike4Mind Bot`
   - **Slack rate limited** → Wait and re-enable; consider reducing subscription volume
2. Fix the underlying issue
3. Re-enable the subscription in Settings → Webhooks → Subscriptions

### Delivery Retry

To retry a failed webhook delivery:

1. Navigate to **Settings → Webhooks → Deliveries**
2. Find the failed delivery by correlation ID or timestamp
3. Click **Retry**
4. Or via API: `POST /api/webhooks/deliveries/{id}/retry`

### Webhook Rate Limiting

**Symptoms:** `429 Too Many Requests` on webhook endpoint

**GitHub webhooks:** No Bike4Mind-imposed rate limit on incoming webhooks.

**Jira webhooks:** Limited to 120 requests/minute per webhook config (60-second sliding window).

**Resolution:** If Jira webhooks are being rate limited, consider:
- Reducing the number of subscribed events
- Filtering to specific projects rather than all projects

## Rate Limit Issues

### GitHub Rate Limits

| Limit | Value | How to Check |
|---|---|---|
| REST API | 5,000 requests/hour | Error message includes reset time |
| Search API | 30 requests/minute | Error message includes reset time |
| GraphQL | 5,000 points/hour | Error message includes remaining points |

**Resolution:** Wait for the reset period shown in the error. Reduce request frequency by:
- Batching related queries
- Using specific filters instead of listing everything
- Caching results in your conversation context

### Atlassian (Jira/Confluence) Rate Limits

| Limit | Value |
|---|---|
| REST API | Varies, typically 100-500 requests/minute |
| Bulk operations | Each item counts separately |

**Resolution:** Wait for the `Retry-After` period. For bulk operations, consider reducing batch size.

### Slack Rate Limits

| Limit | Value |
|---|---|
| `chat.postMessage` | 1 message/second per channel |
| General Web API | Varies by method |

**Resolution:** Slack rate limits are handled automatically with retries. If delays persist, reduce activity volume.

## Permission Issues

### GitHub

| Issue | Resolution |
|---|---|
| "Cannot access repository" | Ensure you have read access to the repo on GitHub |
| "OAuth app not approved" | Ask your org admin to approve the Bike4Mind OAuth app |
| "Resource not accessible" | The OAuth scope may be insufficient; reconnect with full scopes |

### Jira

| Issue | Resolution |
|---|---|
| "You do not have permission" | Check your Jira project role (admin, developer, viewer) |
| "Issue does not exist" | You may lack permission to view the issue; check project access |
| "Cannot transition" | The transition may require specific conditions or permissions |

### Confluence

| Issue | Resolution |
|---|---|
| "Space not found" | Verify space key (case-sensitive) and your space membership |
| "Cannot edit page" | Check page restrictions — you may need edit access |
| "Cannot delete comment" | You can only delete comments you created |

## Per-Integration Troubleshooting

### GitHub {#github}

| Problem | Solution |
|---|---|
| Agent can't find repository | Verify repo name (owner/repo format) and your access |
| Search returns no results | GitHub search only covers indexed code; very recent commits may not appear |
| PR diff too large | Use `get_pull_request_files` instead of `get_pull_request_diff` |
| Draft PR conversion fails | May hit GraphQL rate limits separately from REST API |
| Workflow logs unavailable | Logs are only available for recent runs (GitHub retention policy) |

### Slack {#slack}

| Problem | Solution |
|---|---|
| Bot doesn't respond | Invite bot to channel: `/invite @Bike4Mind Bot` |
| "Not connected" error | Link Slack account in Profile → Integrations |
| Slow responses | May be Slack rate limited; wait and retry |
| Bot doesn't see messages | Ensure bot has `channels:history` scope |
| Commands not available | App may need reinstallation if scopes changed |

### Jira {#jira}

| Problem | Solution |
|---|---|
| "Site not found" | Disconnect and reconnect, selecting the correct site |
| JQL returns no results | Verify JQL syntax; use `jira_search_issues` tool with simpler queries first |
| Can't create subtask | Ensure parent issue exists and subtask type is available |
| Sprint not found | Verify sprint belongs to the correct board |
| Bulk operation partial failure | Check error response for per-item failure details |

### Confluence {#confluence}

| Problem | Solution |
|---|---|
| Page not found by title | Use exact title; for fuzzy search, use `confluence_search` with CQL |
| Content formatting issues | Complex macros/layouts may not render correctly; use simple HTML |
| Attachment upload fails | Check file size against Confluence instance limits |
| Version conflict (409) | Another user edited the page; retry the update |
| Personal space not found | Personal spaces may need to be created manually in Confluence first |

## Error Code Reference

| HTTP Status | Meaning | Common Causes |
|---|---|---|
| `400` | Bad Request | Invalid input, malformed query (JQL/CQL), missing required fields |
| `401` | Unauthorized | Token expired, revoked, or invalid |
| `403` | Forbidden | Rate limit exceeded, insufficient permissions, or scope missing |
| `404` | Not Found | Resource doesn't exist or you don't have access |
| `409` | Conflict | Version conflict (Confluence), duplicate resource (GitHub) |
| `413` | Payload Too Large | Webhook payload or attachment exceeds 1 MB limit |
| `422` | Unprocessable Entity | Valid JSON but invalid content (bad label, duplicate name) |
| `429` | Too Many Requests | Rate limit exceeded — check `Retry-After` header |
| `500` | Internal Server Error | Server-side issue — retry or contact support |

## External Service Status Pages

If an integration is completely unresponsive, check the external service status:

- **GitHub:** [https://www.githubstatus.com/](https://www.githubstatus.com/)
- **Slack:** [https://status.slack.com/](https://status.slack.com/)
- **Atlassian (Jira + Confluence):** [https://status.atlassian.com/](https://status.atlassian.com/)

## Getting Help

If your issue isn't covered here:

1. Check the integration-specific documentation (linked from each section above)
2. Contact your organization admin for access and permission issues
3. For persistent issues, reach out to Bike4Mind support with:
   - The integration affected
   - The exact error message
   - Steps to reproduce the issue
   - Your organization name

## Related Documentation

- [GitHub Integration](./github-integration.md)
- [Slack Integration](./slack-integration.md)
- [Jira Integration](./jira-integration.md)
- [Confluence Integration](./confluence-integration.md)
- [External Integrations Overview](./index.md)
