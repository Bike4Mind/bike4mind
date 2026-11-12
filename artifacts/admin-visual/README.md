# Admin visual verification - partial matrix

All 38 screenshots in `matrix.json` are real React component fixtures, NOT full-app or end-to-end evidence. The fixture mounts the production admin skin and page frame without the app sidebar, authentication, backend, or live data. Browser viewport height is 1000; full-page image heights vary.

## Coverage

| Surface | Light/dark 1440 | Light/dark 768 | Light/dark 390 | Evidence |
| --- | --- | --- | --- | --- |
| Integrated DLQ table and recommendations | Captured/inspected | Captured/inspected | Captured/inspected | Real complete tab fixture |
| DLQ batch replay dialog | Captured/inspected | Captured/inspected | Captured/inspected | Real dialog opened through tab |
| DLQ single replay dialog | Captured/inspected | Captured/inspected | Captured/inspected | Real dialog opened through tab |
| AI operations | Captured/inspected | Captured/inspected | Not captured | Real complete tab fixture; empty class/recent tables |
| Dashboard morning brief | Captured/inspected | Captured/inspected | Not captured | Real card only, NOT full Dashboard |
| Feedback close dialog | Captured/inspected | Captured/inspected | Not captured | Real dialog; initial resolution state only |
| Feedback internal history | Captured/inspected | Captured/inspected | Not captured | Real history component, NOT full drawer/list |
| Flat settings row | Captured | Captured | Not captured | Row primitive only; NOT actual settings fields/pages |
| Analytics | Missing | Missing | Missing | No visual pass claimed |
| Organizations, credit analytics, API keys, security dashboard, audit log, admin settings | Missing | Missing | Missing | No visual pass claimed |
| Growth and pricing/all admin settings sub-tabs | Missing | Missing | Missing | No visual pass claimed |

## Paths

All paths below are relative to the repository root:

- `artifacts/admin-visual/matrix.json`: exact filenames, viewport widths, themes and document overflow measurements.
- `artifacts/admin-visual/dlq-{table,batch,single}-{light,dark}-{1440,768,390}.png`: 18 original DLQ captures.
- `artifacts/admin-visual/{ai,brief,feedback-close,feedback-history,setting-row}-{light,dark}-{1440,768}.png`: 20 other captures.
- `artifacts/admin-visual/contact-{table,batch,single,ai,brief,feedback,setting}.png`: labelled contact sheets; source images remain authoritative.

DLQ dialogs and contact sheets, AI, brief and feedback contact sheets were displayed inline during verification. Every recorded document width equals the viewport width. Wide tables scroll internally; fixture gutters are 32px at 768/1440 and 16px at 390. Compact DLQ rows and dialog footer/reason controls are visible. This does not verify sidebar interactions, API behavior, keyboard saves, successful mutations, or production data.

## Confirmed fix

AI feature metrics crushed feature/mode cells and truncated headers at 768px. `AiOperationsTab` now gives this eight-column table a `90rem` minimum width, keeping horizontal scroll within DataTable. A regression test asserts that minimum. Captures were regenerated after the fix.

## Reproduce

Start the isolated fixture from the repository root:

`pnpm --filter @bike4mind/client exec vite --config visual-admin/vite.config.mjs`

Then run `pnpm --filter @bike4mind/client exec node visual-admin/capture.mjs`.

The harness binds only to 127.0.0.1:4317, uses installed Chrome, and substitutes local data/identity boundaries. AI/DLQ/history writes reject; feedback dialog confirmation is a no-op. It is visual-only tooling, excluded from the production TypeScript project. No dependency, credential, database, or shared server configuration was changed.

## Checks and limitations

- 44 tests across AI operations, DLQ, brief, feedback close/history passed.
- Targeted ESLint on the production AI component and regression test passed.
- Core dependency builds passed.
- Full client TypeScript check timed out after 300 seconds; no successful full typecheck is claimed.
- Console emitted existing Joy/Emotion `:first-child` SSR warnings; these are not captured by the matrix's `pageerror` field.
- Required full-page screenshot coverage remains incomplete as listed above. The runtime conflict prevented reuse of port 3000; its owner was never stopped or modified.
