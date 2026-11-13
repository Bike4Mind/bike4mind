# Bike4Mind Android

Native Android client (Kotlin). `make test`, `make build`, `make generate-client` (see the Makefile). Needs a JDK 17+ on
`PATH`; Gradle comes from the pinned wrapper. CI: [`.github/workflows/android.yml`](../../.github/workflows/android.yml),
path-filtered to this directory and kept out of the web pipelines, as `apps/ios` is.

## Modules

- **client**: the generated OpenAPI client (see below), a plain Kotlin/JVM library the app depends on.

## Generated API client

`client/` is generated from the backend's OpenAPI spec with [openapi-generator](https://openapi-generator.tech)'s
`kotlin` generator, library `jvm-ktor`, serialization `kotlinx_serialization`, at the version pinned in
`gradle/libs.versions.toml`. The pipeline follows `apps/ios/Packages/B4MClient`:

- **Committed output.** `client/generated` is checked in, so a regeneration is a reviewable diff and building never runs
  the generator. CI regenerates from the snapshot and fails on any diff.
- **Snapshot.** `client/openapi.json` is a copy of `apps/client/public/openapi.json` with overlay-only enum values
  stripped (`scripts/strip_overlay_literals.py`). Refresh it with `make generate-client SPEC_REF=origin/main`.
- **Open enums.** `scripts/open_enums.py` drops every string `enum` before generation, so a value the server adds later
  decodes as a plain string instead of failing the whole response on every installed build. A test guards it.
- **Filter.** `client/operations.txt` lists the operations the app uses; `scripts/filter_operations.py` prunes the rest
  of the spec and every schema they do not reach. Add an operationId there when a screen needs it.
- **JSON.** Pass `installB4MJson()` as each API's `httpClientConfig`: the generator installs no converter, and
  `B4MClientJson` ignores unknown keys and decodes omitted optionals as null. OpenAPI `number` maps to `Decimal`
  (an exact `BigDecimal`), free-form values to `JsonElement`.
- `sendChatMessage` is excluded, as on iOS: its response is an anyOf the generator flattens into one class that
  cannot decode the queued shape.

The two Python scripts `open_enums.py` and `strip_overlay_literals.py` are copies of the iOS ones; change both together.
