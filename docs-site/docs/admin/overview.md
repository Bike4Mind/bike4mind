---
title: Admin Dashboard Overview
description: Overview of the Bike4Mind admin panel layout, navigation, and environment awareness
sidebar_position: 1
tags: [admin, dashboard, navigation]
---

# Admin Dashboard Overview

The Bike4Mind admin dashboard is the central hub for platform administration. It provides tools for managing users, monitoring system health, configuring settings, and analyzing platform usage. Access is restricted to users with admin privileges; non-admin users see an "Admin Access Only" message.

## Layout

The admin panel is organized as a full-screen view with three main areas:

| Area | Description |
|------|-------------|
| **Environment Banner** | A color-coded sticky bar at the top indicating the current environment |
| **Left Sidebar** | An accordion-based navigation menu for switching between admin tabs |
| **Main Content Area** | The active tab's content, occupying the majority of the screen |

## Environment Banner

The environment banner is always visible at the top of the admin panel. It uses color coding to clearly indicate which environment you are working in, reducing the risk of unintended changes in production.

| Environment | Color | Hostname Pattern |
|-------------|-------|-----------------|
| Local Development | Green | `localhost` |
| Staging | Blue | Contains `staging` |
| Production | Red | `app.bike4mind.com` |
| Unknown | Yellow | Any other hostname |

The banner includes a close button on the right side that navigates back to the previous page.

## Sidebar Navigation

The left sidebar uses an accordion group with three collapsible sections. Each section can be independently expanded or collapsed. All three sections are expanded by default.

### User Ops

The User Ops section contains tabs focused on user and account management:

| Tab | Description |
|-----|-------------|
| Users | Search, view, edit, and manage user accounts |
| Email Verification | Monitor and manage email verification status |
| Feedbacks | Review and triage user-submitted feedback |
| Migration | Bulk migrate users into the platform (conditional, requires feature flag) |
| Analytics | View user activity reports and analytics |
| Invite Codes | Manage registration invite codes |
| Subscribers | View and manage newsletter subscribers (shows a badge count for waiting subscribers) |
| Email Marketing | Email marketing campaigns |
| Subscriptions | Manage user subscriptions |
| Organizations | Manage organizations |
| Credit Analytics | Analyze credit usage across the platform |
| Bulk Import | Import users in bulk |
| Team | Manage team members |

### General Ops

The General Ops section contains tabs for system configuration and operational tools:

| Tab | Description |
|-----|-------------|
| Admin Settings | Platform-wide configuration settings |
| System Health | Monitor system health status |
| LLM Dashboard | Large language model configuration and monitoring |
| Tool Definitions | Manage tool definitions available to AI |
| Rapid Reply | Configure rapid reply templates |
| System Prompts | Manage system-level prompts |
| Agent Operations | Monitor and manage AI agent operations |
| Documentation | Internal documentation management |
| Modals | Configure application modals |
| What's New | Manage "What's New" announcement modals |
| LiveOps Triage | Live operations triage (conditional, hidden on fork production environments) |
| Secrets Rotation | Manage secret rotation schedules |
| System Secrets | View and manage system secrets |
| Identity Providers | Configure identity provider integrations |
| Slack Workspaces | Manage Slack workspace connections |
| Model Metrics | View model performance metrics |
| Event Metrics | Track system event metrics |
| Slack Metrics | Monitor Slack integration metrics |
| Security Dashboard | Security monitoring dashboard |

### Advanced

The Advanced section contains specialized tools:

| Tab | Description |
|-----|-------------|
| World Time | View current time across different time zones |

## Tab System

The admin panel uses a vertical tab system where clicking a sidebar button activates the corresponding tab in the main content area. Tabs are lazy-loaded, meaning their content is only rendered when the tab is active, which improves initial load performance. Several tabs use dynamic imports via `next/dynamic` for code splitting.

## Default Tab Behavior

- The default active tab is **Users** when the admin panel opens.
- If the `enableUserMigration` feature flag is active and the current tab is Users, the panel automatically switches to the **Migration** tab instead.

## Notification Badges

The Subscribers tab displays a red notification badge when there are waiting subscribers. The badge shows the count of pending subscribers and can be dismissed. This badge is only visible when the count is greater than zero and the notification has not been hidden.

## Best Practices

- Always check the environment banner color before making changes to confirm you are in the intended environment.
- Use the sidebar accordion collapse feature to reduce visual clutter when working within a specific section.
- The admin panel requires the `isAdmin` flag on the current user -- ensure admin privileges are granted appropriately through the Users tab.

---

## Related Articles

- [User Management](./user-management.md) - Managing user accounts
- [Email Verification](./email-verification.md) - Email verification administration
- [Feedbacks](./feedbacks.md) - Feedback triage and management
- [Analytics](./analytics.md) - Platform analytics and reporting
