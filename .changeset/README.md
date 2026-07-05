# Changesets

This folder is used by [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs for `@bike4mind/*` packages.

## How to use

Before merging a PR that changes code in `b4m-core/` or `packages/cli/`, create a changeset:

```bash
pnpm changeset
```

This will prompt you to:
1. Select which packages were affected
2. Choose a bump type (major / minor / patch)
3. Write a changelog summary

A `.changeset/<random-name>.md` file is created — commit it with your PR.

## What happens automatically

- **Feature branches:** Snapshot versions are published automatically when tests pass. No changeset file needed.
- **Main branch:** When changeset files are pending, a "Version Packages" PR is created. Merging it publishes stable versions to npm and creates GitHub releases.

## More info

- [Changesets docs](https://github.com/changesets/changesets)
- [Using Changesets with pnpm](https://pnpm.io/using-changesets)
