# @bike4mind/agents

## 0.19.0

### Minor Changes

- let sub-agents opt into Lattice tools via allowedTools

- render artifacts in Agent mode at parity with chat

- backgroundable + pollable shell sessions for bash_execute

- track and display token/credit usage for spawned agents

### Patch Changes

- backfill tool_result for unexecuted tool calls when the agent loop is aborted

- unify on a rich message model + a ConversationContext deep module

- recover mid-loop context-limit errors via reactive compaction

- collapse partial-stream final_answer repeats into one StepRow

- Updated dependencies:
  - @bike4mind/common@3.0.0
  - @bike4mind/llm-adapters@0.10.0
  - @bike4mind/utils@3.0.0
