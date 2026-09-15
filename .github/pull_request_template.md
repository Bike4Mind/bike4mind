# Pull Request

## Optional Screenshot/Video
<!--
If applicable, add screenshots or a video to help explain your changes. This can be particularly useful for UI changes or visual bug fixes.
-->

## Description
<!--
Provide a detailed description of what this PR does. Explain the problem you're solving or the feature you're adding.
-->

## Changes
<!--
List the changes you've made in this PR. This is to help the reviewers understand the impact of your changes.
- Change 1
- Change 2
- ...
-->

## Guide for Testers
<!--
Write step-by-step instructions that both human QA testers AND AI agents (e.g., Playwright) can follow without codebase knowledge.

Requirements:
- Number every step — one action per step
- Use exact navigation paths: "Sidebar → Admin → DLQ Management"
- Use exact URLs: "app.staging.bike4mind.com"
- Use exact input values: type `Hello, how are you?` in the message input
- State expected results after each step: "A response appears within 10 seconds with no errors"
- Include a "Regression Checks" section for refactors
- Include a "What NOT to test" section for infra/backend-only PRs

See CLAUDE.md → "Test Guide Standards" for full guidelines and examples.
-->

## Additional Information
<!--
Include any additional information or context that you think would be helpful for your reviewers.
-->

## Developer Notes (Optional)
<!--
Document capability unlocks, architectural improvements, and reusable patterns introduced by this PR.
This helps future developers understand what new building blocks are available.

Categories to consider:
- **New Extension Points**: Components/interfaces that accept new props, hooks, or configuration
- **Reusable Patterns**: New components, utilities, or approaches that can be applied elsewhere
- **Data Model Changes**: New fields, types, or structures that enable future features
- **Architecture Decisions**: Why something was built a certain way (not just what changed)

Example:
- `SchedulerTab` now accepts a `familyId` prop — any new pattern family automatically gets a Learn tab
- `ComingSoonPanel` component can be dropped into any tab to indicate future work
- `effectiveTab` pattern shows how to handle persisted tab state when tabs become conditionally disabled
-->

## Security Testing (for security-labeled PRs only)
<!--
Required for any PR closing a security-labeled issue. Delete this section
if the PR is not security-related.

Preview environments are created on demand by maintainers via an internal deploy pipeline.
There's no label or comment command to request one yourself. When a maintainer triggers a
preview, a bot comment with the `pr<N>.preview.bike4mind.com` URL appears on this PR.
See CONTRIBUTING.md → "Preview deploys".
-->

- [ ] Vulnerability reproduced on **staging** with a script/curl (output attached as PR comment)
- [ ] Fix verified on **PR preview** env with the same script (output attached as PR comment)
- [ ] Production is assumed to match staging (no direct-to-prod deploys). If BEFORE reproduction on staging fails unexpectedly, verify no upstream fix has already landed: `git log origin/main -- <file>`

## Checklist

- [ ] I have added the new AdminSettings to Staging, prod and the hydration script (if applicable)
- [ ] I have made the UI/UX feel good (toasters, size, responsive, etc)
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation (if applicable)
- [ ] My changes generate no new warnings
- [ ] If adding/modifying telemetry fields: updated [telemetry data classification](../docs-site/docs/security/telemetry-data-classification.md) doc
