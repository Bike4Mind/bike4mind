---
title: 'Teams'
description: 'How Teams work in Bike4Mind: creating a team, what it costs, how many people and credits it includes, who pays for usage, and how to manage members and roles'
sidebar_position: 7
tags: [organizations, teams, collaboration]
---

# Teams

A Team is a shared workspace for a group of people. Everyone on a Team draws from one shared pool of credits, and the Team owner manages the subscription, the seats and the members.

Before subscribing, [preview Team administration](./team-admin-preview.md) with fictional members, monthly limits and usage examples. You do not need an account or a paid Team to read the preview.

## Open the Teams page

Open the account menu in the sidebar and choose **Teams**. The page lists every Team you belong to. Each card shows the Team name, whether it is a personal or shared team, the number of seats, the number of members, the credits, and the subscription status (Active Subscription, No Subscription or Payment Issue). Use **View Details** to open a Team, or the search box to filter the list.

## Create a Team

1. On the Teams page, click **Create Team**.
2. In the **Create New Team** dialog, type a **Team Name**.
3. Under **People on the plan**, type a number or use the minus and plus buttons to pick how many people the plan covers. It starts at 4, the number of people one flat price covers, so a team of two or three leaves it at 4 and pays the same. Raise it only to make room for more people. The note under the picker states the range, which Bike4Mind sets and can change. If you type a number outside the range, the field shows a "Must be between" error and **Create Team** stays disabled until you fix it. A decimal such as 7.4 is rounded to the nearest whole number. If you need a PO, invoice or other custom billing, use the **Contact us** link in the dialog, which opens the Bike4Mind support page in a new tab.
4. Read the **Total Price** line, which shows the monthly total for the number you picked.
5. Click **Create Team**. You are sent to a secure checkout to pay for the subscription.

If the dialog says that Team pricing is unavailable, the price could not be loaded. Nothing is charged; try again later.

### What the plan includes

- **Price:** the price per seat is loaded live from the payment provider, so it is not written here. The dialog shows the monthly total for your chosen number of seats, and the Billing tab shows the price per seat per month.
- **People included:** the flat price covers up to 4 people, and you don't have to fill them: a pair or a trio pays the same. Each seat is room for one person, and the owner counts as one. A Team of 4 seats has the owner plus up to 3 other people; add seats to make room for more.
- **Credit pool:** each seat adds a set amount of credits to the Team's shared pool when you subscribe and at each renewal. When you add seats in the middle of a billing period, the new seats add a prorated share of that amount. The standard amount is 50,000 credits per seat, but it is a Bike4Mind setting and can change. The Team's card on the Teams page shows the credits currently in the pool.
- **Who pays for the plan:** the Team owner, through the subscription.

## Who pays for usage

Usage is charged to whichever account you have selected in the account menu, not to the person who owns the notebook or project.

- With a Team selected, your messages are paid from that Team's credits.
- With your personal account selected, your messages are paid from your own balance.
- In a notebook that someone else owns, a small note above the message box tells you which one applies, for example "Paid from your balance, not the owner's" or "Paid from (Team name) credits, not the owner's".

## Add and manage members

Open a Team with **View Details**. The Team page has an **Overview** tab and a **Members** tab. Other tabs (Groups, Usage, Analysis, Integrations, Connectors, Settings) appear only for people with the right access. The Usage tab, which shows the Team's credit usage, is for the owner and platform admins; being a Team manager does not grant access. The **Billing** tab is visible to the owner only. A Team manager finds the Team in the Teams list marked with a **Manager** badge.

On the **Members** tab:

- The heading shows how many seats are in use, for example "Members (3 / 10)". Pending invites hold a seat until they are accepted or cancelled.
- The Team owner, Team managers and platform admins can invite people, cancel pending invites and remove members. Only the owner and platform admins can remove a Team manager. Click **Add Member**, type at least 3 characters, select a person and add them. The search finds people you already share a Team or project with by name, or anyone by their full email address. They receive an invite and show as **Pending** until they accept. New invites give the **Viewer** role.
- If every seat is taken, the owner sees "You've reached your seat limit" and needs to add seats before inviting more people.
- Use the three-dot menu on a member to **Revoke Access**, or on a pending invite to **Cancel Invite**. Each option appears only to people who are allowed to use it. Members can choose **Leave Team** for themselves.
- The Team owner, Team managers and platform admins can cap monthly credit spending. The **Monthly credit limit per member** card sets a default (**Set limit** or **Change limit**), and **Set monthly limit** in a member's menu sets a limit for one person. With no limit, members can spend from the pool without a monthly cap.

## Custom connector policy

If you are the Team owner, a current Team manager or a platform admin, open **View Details > Connectors** to manage custom MCP connectors for the Team's members.

- Turn **Custom connectors** off to block members' custom connector tools. Policy changes can take up to five minutes to reach every server handling requests. Members can still remove their connections.
- Choose catalog connectors only, allowed hosts only, or any host. Blocked hosts apply in every mode. Enter host patterns one per line; `*.example.com` matches subdomains but does not match `example.com` itself.
- Choose whether every tool call needs approval, whether tools without a read-only annotation are allowed, whether servers without sign-in are allowed, and the connection limit per member.
- Click **Save policy** to apply your changes. **Use platform default** removes the Team's override and loads the deployment's default policy.

**Member connections** lists connections created under this Team by its current members, with their status under this Team's policy. Members manage their own connections. Older connections saved without a Team association do not appear here: membership alone cannot establish which Team a personal connection belongs to, so those connections are not automatically assigned or exposed to Team admins. The Team's policy still applies to its members.

### Troubleshooting connectors

If you do not see **Connectors**, ask the Team owner to check your management access. An **Admin** role label alone does not make you a Team manager.

If the deployment has custom connectors turned off, the page shows a notice; saving a Team policy cannot turn them on. If the saved policy is invalid, save a valid replacement or use **Use platform default**. If a policy or member-connections request fails, use **Retry** instead of treating the missing data as an empty list. A member who belongs to several Teams is subject to every Team's connector policy, so another Team's restrictions can also block a connection.

## Roles

Each member shows a role label on the Members tab.

- **Owner:** created the Team and holds the subscription.
- **Admin**, **Editor** and **Viewer:** the access level shown on a member. Viewer is the level new invites start with. These labels do not decide who manages the roster: the Team owner, Team managers and platform admins do.

## Billing tab (owner only)

The Billing tab shows **Billing & Subscription**:

- Plan status: **Team Plan** with Active, Canceled or Payment issue, and the renewal or end date.
- **Subscribe Now** if the Team has no subscription yet.
- **Team Seats Usage**, for example "5 / 10 seats used", with the number of seats still available.
- **Manage Seats** to change the number of seats. The dialog is called **Update Team Seats**; type the number of seats or use the minus and plus buttons, and it shows the price per seat per month and the new total. You cannot go below the number of people already on the Team (the owner counts) or below the minimum Team size (the lowest number the dialog accepts is the larger of the two, and typing a number outside the range shows an error). People you have invited who have not yet accepted also count toward the minimum when you save: the dialog does not include them in its limit, so if you enter fewer seats than your members plus pending invites, the update is rejected with a message naming the minimum, and you can cancel invites or enter a higher number. The changes show up on your next billing cycle. While the Team has a payment issue, Manage Seats is hidden until the payment is fixed.
- **Billing Portal** to update your payment method, view invoices and manage or cancel the subscription.

If a payment fails, the Team shows **Payment Issue** and the Billing Portal is where you update your card.

## Related Features

- [Projects](./projects.md) - Team project collaboration
- [Profile & Settings](./profile-settings.md) - Account and security settings
- [Notebooks](./notebooks.md) - Shared team conversations
- [Knowledge Management](./knowledge-management.md) - Team knowledge bases
