# @bike4mind/typescript-config

Shared TypeScript configurations for the Bike4Mind monorepo.

## Available Configurations

| Config | Description | Use Case |
|--------|-------------|----------|
| `base.json` | Base TypeScript settings with strict mode | Foundation for all configs |
| `next.json` | Next.js applications | Frontend apps using Next.js |
| `node.json` | Node.js backend services | Backend services, Lambda functions |
| `library.json` | Publishable library packages | Shared packages with type declarations |

## Usage

Add the package as a dev dependency:

```json
{
  "devDependencies": {
    "@bike4mind/typescript-config": "workspace:*"
  }
}
```

Then extend the appropriate config in your `tsconfig.json`:

### Next.js Application

```json
{
  "extends": "@bike4mind/typescript-config/next.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

### Node.js Service

```json
{
  "extends": "@bike4mind/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist",
    "baseUrl": "."
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
```

### Library Package

```json
{
  "extends": "@bike4mind/typescript-config/library.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

## Configuration Details

### Base Config

Strict TypeScript settings shared by all configurations:

- `strict: true` - Enable all strict type-checking options
- `esModuleInterop: true` - Interoperability between CommonJS and ES modules
- `skipLibCheck: true` - Skip type checking of declaration files
- `isolatedModules: true` - Required for bundlers like esbuild
- `moduleResolution: "Node"` - Node.js module resolution

### Next.js Config

Extends base with Next.js-specific settings:

- `target: "ES5"` - Browser compatibility
- `jsx: "preserve"` - Let Next.js handle JSX transformation
- `lib: ["DOM", "DOM.Iterable", "ESNext", "WebWorker"]` - Browser APIs
- `noEmit: true` - Next.js handles compilation

### Node.js Config

Extends base with Node.js backend settings:

- `target: "ESNext"` - Modern Node.js features
- `lib: ["ESNext"]` - ESNext APIs only
- `sourceMap: true` - Enable source maps for debugging

### Library Config

Extends base with settings for publishable packages:

- `declaration: true` - Generate `.d.ts` files
- `declarationMap: true` - Generate declaration source maps
- `composite: true` - Enable project references
- `sourceMap: true` - Enable source maps
