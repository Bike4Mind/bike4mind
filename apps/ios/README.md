# Bike4Mind iOS

`make build`, `make test`, `make format`, `make lint` (see the Makefile).

## Generated API client

`Packages/B4MClient` is generated from the backend's OpenAPI spec with
[swift-openapi-generator](https://github.com/apple/swift-openapi-generator) 1.14.3 (pinned exactly in
`Tools/Generator/Package.swift`; runtime pinned in `Packages/B4MClient/Package.swift`).

- **Committed output, no build plugin.** `Sources/B4MClient/Generated` is checked in, so a regeneration is a
  reviewable diff and building the app never fetches or compiles the generator.
- **Snapshot.** `Packages/B4MClient/openapi.json` is a copy of `apps/client/public/openapi.json`.
- **Filter.** `openapi-generator-config.yaml` lists the operations the app uses. The full spec generates
  ~140k lines; add an operation to the `filter.operations` list when a screen needs it.
  `sendChatMessage` is excluded for now: its request schema has both `max_tokens` and `maxTokens`, which
  collide and do not compile. Chat (M3) has to fix that first.

Regenerate:

```sh
make generate-client                          # re-run on the committed snapshot; git diff must be empty
make generate-client SPEC_REF=origin/main     # take a new snapshot from a git ref
make generate-client SPEC_FILE=/path/openapi.json
```

Screens never use generated types: `B4MKit` maps them to domain models behind the `B4MAPI` protocol
(`APIClient` is the implementation), so a regeneration cannot ripple into the UI.

## UI fixtures

A DEBUG build launched with `B4M_UI_FIXTURES=1` skips sign-in and serves canned sessions, transcript
and credits (`Bike4Mind/Features/Debug/FixtureServices.swift`):

```sh
SIMCTL_CHILD_B4M_UI_FIXTURES=1 xcrun simctl launch booted com.bike4mind.app
```
