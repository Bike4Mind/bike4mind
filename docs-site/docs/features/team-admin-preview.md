---
title: Team administration preview
description: Preview Team members, monthly credit limits and usage before subscribing, with fictional read-only examples and current access rules.
sidebar_position: 8
tags: [organizations, teams, collaboration]
---

# Team administration preview

You can review these examples without an account, a subscription or a payment method. From the app, open the account menu, choose **Teams**, then **Preview Team administration**, even when you have no Teams.

These read-only examples use fictional data. They illustrate the information in the Team views; they are not screenshots or a live Team. The example limits are choices for this sample, not plan allowances. Nothing on this page changes your account or creates a subscription.

## Members and monthly limits

In a Team, open **View Details > Members** to see members, pending invitations and credit usage. For example, a four-seat Team with two members and one pending invitation has one seat available.

**Monthly credit limit per member**

Each member can spend up to **10,000 credits per month** in this example. Members with their own limit use that limit instead. Usage resets on the first day of each month, in UTC.

| Member | Role | Status | Credits this month |
| --- | --- | --- | --- |
| Sample owner | Owner | Accepted | 2,400 / 10,000 |
| Sample member | Viewer | Accepted | 1,200 / 5,000 |
| Sample invitee | Viewer | Pending | - |

The sample member has a **5,000-credit individual limit**, overriding the **10,000-credit Team default**. A pending invite has no usage yet and holds a seat until accepted or cancelled. If the app shows **Not tracked**, there is no usage record for that member; it does not mean zero usage.

The owner, Team managers and platform admins can use **Set limit** or **Change limit** on the default card, or **Set monthly limit** in a member's menu. With no effective limit, a member can spend from the shared pool without a monthly cap. The shared pool still needs enough credits to pay for usage.

## Usage by member

The Team owner can open **Usage > Usage** to review credits over time and breakdowns including **By member** and **By model**. Platform admins also have access. Being a Team manager does not grant Usage access.

For an example reporting window, the **By member** breakdown contains:

| Member | Requests | Credits |
| --- | --- | --- |
| Sample owner | 80 | 2,400 |
| Sample member | 40 | 1,200 |

These are illustrative values. The Usage reporting window and the Members tab's current calendar month can cover different dates, so their totals need not match. Only usage paid from this Team's credits belongs to its usage view; personal-account spending is separate.

The **Ledger** subtab shows credit transactions, and **Storage** shows the Team storage pool. The credit ledger is not an audit log of administrative actions.

## Which controls you can access

| Control | Access |
| --- | --- |
| Invite members or cancel pending invites | Team owner, Team managers and platform admins |
| Set default or individual monthly limits | Team owner, Team managers and platform admins |
| Remove members other than Team managers | Team owner, Team managers and platform admins |
| Remove a Team manager | Team owner and platform admins |
| View the Usage tab | Team owner and platform admins |
| Billing tab, seat changes and Billing Portal | Team owner |

A Team manager is not a Bike4Mind platform admin. The **Admin** role label on a member does not make them a Team manager. See [Teams](./organizations-teams.md) for the full membership and billing workflow.

## Audit and security scope

The Team view does not include a customer-facing **Audit Log** tab or Team audit-log export. The platform **Audit Log** is restricted to Bike4Mind platform admins and is not a Team subscription control.

This preview does not demonstrate Team SSO enforcement or a separate administrative report export. Do not treat those as included controls based on this page. Your personal MFA, active sessions and data export are separate account settings; see [Profile & Settings](./profile-settings.md).
