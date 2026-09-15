---
title: Security Dashboard
description: Monitor your platform security posture across code, web, cloud, packages, and secrets scanning categories
sidebar_position: 28
tags: [admin, security, dashboard, monitoring]
---

# Security Dashboard

The Security Dashboard provides a centralized view of your platform's security posture across multiple domains. It aggregates results from automated security scans covering website vulnerabilities, code analysis, dependency auditing, secrets detection, and cloud infrastructure configuration. The dashboard includes an AI-powered security assessment that generates prioritized recommendations.

## Dashboard Layout

The Security Dashboard is accessed from the General Ops section of the admin sidebar. It renders inside a wrapper component (`SecurityDashboardMock`) that hosts the full React-based dashboard.

The dashboard uses a tabbed interface with the following sections:

| Tab | Icon | Description |
|-----|------|-------------|
| **Overview** | Home | Aggregated security score, check summaries, and AI assessment |
| **Website Security** | Lock | OWASP ZAP scan results for web vulnerabilities |
| **Code Analysis** | Code | Semgrep static analysis findings |
| **Packages** | Package | Dependency audit for known vulnerabilities |
| **Secrets** | Key | Detection of exposed API keys, tokens, and passwords |
| **Cloud** | Cloud | AWS IAM, S3, and infrastructure configuration checks |
| **Firewall / WAF** | Shield | Web Application Firewall status (coming soon) |

## Overview Tab

The Overview tab displays three main areas:

### Security Score

A large circular score indicator (out of 100) with a label based on the score range:

| Score Range | Label |
|-------------|-------|
| 85 and above | Excellent |
| 70 to 84 | Good |
| 50 to 69 | Moderate |
| Below 50 | At Risk |

Below the score, summary metadata is shown:

- **Last Updated** -- timestamp of the most recent scan data
- **Security Checks** -- number of passed checks vs. total checks (e.g., "5/6 Passed")
- **Next Scan** -- time until the next scheduled scan

### AI Security Assessment

A gradient card powered by Bike4Mind AI that provides:

- An overall summary of the security posture
- Up to three prioritized recommendations, each with a title, priority level, rationale, and suggested action
- Timestamps for when the AI assessment was last generated and when the next analysis is scheduled

### Category Cards

A grid of cards, one per security check category, each displaying:

| Field | Description |
|-------|-------------|
| **Label** | The security check name |
| **Status** | Color-coded chip -- Passed (green), Review recommended (yellow), Issues detected (red), or Disabled (neutral) |
| **Score** | Numeric score for the category |
| **Summary** | Brief text summary of the check result |
| **Last Checked** | Timestamp of the most recent scan |

## Website Security Tab

Displays results from automated OWASP ZAP scans of the live website.

- **Findings summary** with total count and breakdown by severity (Critical, High, Medium, Low)
- **Visual bar indicators** showing the relative count of each severity level
- **Detailed findings list** with color-coded severity borders, titles, and descriptions
- **Run Website Scan** button to trigger a new scan (subject to cooldown period)

## Code Analysis Tab

Shows results from Semgrep static analysis of the source code.

- **Issue summary** displaying counts by severity level (Critical, High, Medium, Low)
- **Findings list** with individual findings showing title, description, and severity indicators
- **Run Code Scan** button to trigger a new analysis (subject to cooldown period)

## Packages Tab

Audits third-party dependencies for known vulnerabilities.

- **Vulnerability count** with severity breakdown
- **Detailed findings** including package name, version, vulnerable range, recommended version, and advisory links
- **Run Packages Scan** button to trigger a new audit (subject to cooldown period)

## Secrets Tab

Detects exposed API keys, tokens, passwords, and other secrets in repositories.

- **Exposed secrets count** with severity breakdown
- **Findings** showing secret type, file location (path and line number), and remediation recommendations
- Secret values are never displayed in the dashboard
- **Run Secrets Scan** button to trigger a new scan (subject to cooldown period)

## Cloud Tab

Performs baseline checks for IAM, S3, and other AWS services to detect risky configurations.

- **Cloud security posture score** (out of 100) with severity breakdown
- **Findings** with descriptions, recommendations, and links to guidance documentation
- **Run Cloud Scan** button to trigger a new scan (subject to cooldown period)

## Firewall / WAF Tab

This tab is a placeholder. The WAF React view is noted as "coming soon" in the interface.

## Scan Cooldowns

Each scan category has a cooldown period after a scan is triggered. During the cooldown:

- The scan button is disabled
- A message indicates how many hours remain before another scan can be run

## Severity Levels

All scan categories use a consistent four-level severity classification:

| Severity | Color | Description |
|----------|-------|-------------|
| **Critical** | Red (danger) | Immediate action required |
| **High** | Dark yellow (warning) | Address as soon as possible |
| **Medium** | Yellow (warning) | Should be reviewed |
| **Low** | Green (success) | Informational or minor |

## Best Practices

- Review the Overview tab regularly to monitor your overall security score trend.
- Act on AI recommendations in priority order for the highest security impact.
- Address Critical and High severity findings before Medium and Low.
- Run scans after significant deployments or dependency updates to catch new issues early.
- Keep secrets scan results clean by rotating credentials flagged as exposed.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Navigation and layout
