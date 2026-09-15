# @bike4mind/eslint-config

Shared ESLint configurations for the Bike4Mind monorepo.

## Available Configurations

| Config | Description | Use Case |
|--------|-------------|----------|
| `base` | Common JavaScript rules | Foundation for all configs |
| `typescript` | TypeScript-specific rules | TypeScript packages |
| `next` | Next.js-specific rules | Next.js applications |

## Usage

Add the package as a dev dependency:

```json
{
  "devDependencies": {
    "@bike4mind/eslint-config": "workspace:*"
  }
}
```

### Next.js Application

Create an `.eslintrc.cjs` in your package:

```js
module.exports = {
  extends: ['@bike4mind/eslint-config/next'],
  parserOptions: {
    project: './tsconfig.json',
  },
  settings: {
    next: {
      rootDir: __dirname,
    },
  },
};
```

### TypeScript Package

```js
module.exports = {
  extends: ['@bike4mind/eslint-config/typescript'],
  parserOptions: {
    project: './tsconfig.json',
  },
};
```

### JavaScript Package

```js
module.exports = {
  extends: ['@bike4mind/eslint-config/base'],
};
```

## Configuration Details

### Base Config

Common JavaScript rules:

- `prefer-const` - Prefer `const` over `let` when variable is never reassigned
- `no-unused-vars` - Disallow unused variables (with `ignoreRestSiblings`)
- `no-tabs` - Disallow tabs
- `no-trailing-spaces` - Disallow trailing whitespace
- `dot-location` - Enforce dot on property line
- `rest-spread-spacing` - Enforce spacing around rest/spread operators

### TypeScript Config

Extends base with TypeScript-specific rules:

- Uses `@typescript-eslint/parser` for TypeScript parsing
- `@typescript-eslint/no-unused-vars` - TypeScript-aware unused vars (allows `_` prefix)
- `@typescript-eslint/no-explicit-any` - Warn on `any` type usage
- `@typescript-eslint/ban-ts-comment` - Allow `@ts-ignore` with description
- Ignores `sst-env.d.ts` files

### Next.js Config

Extends TypeScript config with Next.js rules:

- Extends `next/core-web-vitals` preset
- `@next/next/no-img-element` - Disabled (allows `<img>` tags)
- **Restricted imports**: Blocks `next/router` and `next/navigation` imports
  - Use `@tanstack/react-router` instead for SPA routing
- Ignores `public/` directory

## Peer Dependencies

This package requires the following peer dependencies:

```json
{
  "eslint": ">=9.0.0",
  "@typescript-eslint/eslint-plugin": ">=8.0.0",
  "@typescript-eslint/parser": ">=8.0.0"
}
```

For Next.js config, you'll also need `eslint-config-next` installed.
