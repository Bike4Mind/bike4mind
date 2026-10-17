# Documentation Site Scripts

This directory contains utility scripts for maintaining the documentation site.

## check-orphaned-docs.ts

A utility script that checks for orphaned documentation files - markdown files that exist in the docs directory but are not referenced in the `sidebars.ts` configuration.

### Usage

```bash
# Run from the docs-site directory
npm run check:orphaned-docs

# Or use the shorter alias
npm run check:docs
```

### What it does

1. **Scans the docs directory** - Recursively finds all `.md` and `.mdx` files
2. **Parses sidebars.ts** - Extracts all file references from the sidebar configuration
3. **Compares the lists** - Identifies files that exist but aren't in the sidebar
4. **Reports issues** - Shows orphaned files grouped by directory
5. **Checks references** - Also identifies files referenced in sidebars that don't exist

### Output

The script provides color-coded terminal output:

- ✅ **Green** - All files are properly referenced
- ❌ **Red** - Found orphaned files or non-existent references
- 💡 **Cyan** - Helpful tips for fixing issues

### Exit codes

- `0` - Success, no orphaned files found
- `1` - Found orphaned files or non-existent references

### Integration

This script can be integrated into CI/CD pipelines to ensure documentation stays organized:

```yaml
# Example GitHub Actions workflow
- name: Check for orphaned docs
  run: |
    cd docs-site
    npm ci
    npm run check:docs
```

### Maintenance

When adding new documentation:
1. Create your `.md` file in the appropriate directory
2. Add a reference to it in `sidebars.ts`
3. Run `npm run check:docs` to verify it's properly linked

### Technical notes

- The script uses a simplified parser for the TypeScript sidebars file
- It handles both `.md` and `.mdx` file extensions
- File references in sidebars should not include the file extension
- The script is written in TypeScript and runs with `tsx` for convenience