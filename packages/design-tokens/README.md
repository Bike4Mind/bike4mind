# @bike4mind/design-tokens

Canonical design tokens for all first-party clients. The visual design lives
here as data; each platform derives its theme from it through an emitter, so
the look stays consistent while pixel-level idioms stay native.

## Layout

```
src/
  schema.ts            Zod schemas: the contract every emitter can rely on
  tokens/
    primitives.ts      color ramps, pre-materialized alpha variants, one-offs
    schemes.ts         semantic light/dark color schemes (background.surface2,
                       text.tertiary, interaction tones per intent, ...)
    typography.ts      font families + size/weight/line-height ramps
    metrics.ts         spacing, radii, shadows, motion durations
    index.ts           designTokens: the assembled, schema-validated token set
  emitters/
    types.ts           TokenEmitter<TOutput>: the named-target interface
    joy.ts             MUI Joy theme fragment (consumed by apps/client)
    cssVariables.ts    --b4m-* CSS custom properties (optional target)
```

## Rules

- **The token source is platform-neutral data.** No MUI (or any other
  framework) vocabulary outside `emitters/`; the Joy names live in the
  explicit mapping in `emitters/joy.ts`.
- **Each scheme mode defines exactly the tokens the design specifies.**
  Emitters emit only defined keys; platform defaults cover the rest. Adding a
  key is a design change and will show up in the web theme parity test
  (`apps/client/app/utils/themes/designTokenParity.test.ts`).
- **Values are seeded from the web theme.** The typography ramps, spacing,
  radii and shadows pin what the web app renders with today, including
  framework defaults the theme never overrode; `motion` pins the de-facto
  transition durations. These are reference values for non-web targets until
  a platform consumes them.

## Adding an emit target

Implement `TokenEmitter<TOutput>` in `src/emitters/<target>.ts`, register it
in `src/emitters/index.ts`, and co-locate a test. The token source and the
existing targets stay untouched.
