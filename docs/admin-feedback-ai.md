# Feedback AI controls and retention

Feedback triage uses decision models and keeps derived labels and similarity vectors only until the original report text expires. Editing, reviewing or rerunning triage does not extend that deadline. New configuration writes reject chat models for feedback triage. Reading a recognized legacy chat-model choice clears only that choice; other controls and feature settings are preserved.

Report deletion and account erasure remove derived feedback AI records. Final triage persistence shares the report/user deletion fences and rechecks the original text and deadline, so a provider response cannot recreate derived content after deletion. Provider work runs outside the database transaction. Private note retention follows the separate feedback-note policy.

The AI operations console displays durable call attempts, known costs and explicitly unknown costs. Replay counts and artifact references are supplied by an administrator; the console does not verify that artifact. Online evidence is currently connected to feedback label reviews. Demotion is evaluated when readiness refreshes and has no minimum sample requirement. Registered reversible apply/Undo handlers remain required for Act; this feature does not add a general autonomous executor.

Attempt metadata (call counts, costs and outcomes) expires 400 days after `startedAt`, including interrupted runs. The database TTL worker deletes expired records asynchronously. Migration `20260921241039` installs the TTL index on existing databases; older records become eligible for deletion when it runs. A run interrupted before settlement can remain marked running; it must not be interpreted as a completed call.

Verification uses injected providers and a disposable local Mongo replica set. Live provider calls, deployed browser checks, responsive visual QA and production DocumentDB verification remain separate checks.
