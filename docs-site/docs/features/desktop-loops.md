---
title: Desktop Loops
description: Repeat a prompt or skill in a desktop conversation while the app is open
sidebar_position: 32
tags: [desktop, productivity]
---

# Desktop Loops

Type `/loop` in the desktop composer to repeat a prompt or skill in the current conversation.

```text
/loop 5m Check whether the build finished
/loop 10m /review src/index.ts
/loop Check the job and choose when to check again
/loop list
/loop stop
/loop help
```

## Timing

Use whole-number intervals with `s` (seconds), `m` (minutes), `h` (hours), or `d` (days), from `30s` to `1d`. The first run starts as soon as the conversation is idle. Later delays start after the previous run completes, not at a fixed wall-clock cadence. After sleep, at most one overdue run starts; missed runs do not accumulate.

Without an interval, the model selects a delay after each run. Desktop asks it to end its final reply with `LOOP_NEXT: 5m`, using a valid interval between `30s` and `1d`. A missing or invalid decision pauses the loop instead of substituting a fixed delay. This scheduling decision uses the normal conversation model and credits, not a separate hidden request.

## Controls and safety

The session side panel's **Background tasks** section shows the loop prompt, cadence, next run time, and any pause reason. Use the session panel button in the conversation header to open it on a narrow window. Use **Stop loop** in that section or `/loop stop` to cancel future runs without interrupting a turn already running. The ordinary Stop button also ends the loop and interrupts the current turn.

When the panel is hidden or Background tasks is folded, a compact **Loop** status and **Stop** action remain visible in the conversation header. Select the status to open the loop details. Loop controls do not appear above the input.

You can have one loop per conversation. Starting another replaces its schedule. A busy conversation waits for its current turn and queued messages; a loop never cancels your work. Permission cards remain open until you answer them. Errors, stopped-short replies, failed turns, and invalid pacing decisions pause the loop. Start `/loop` again explicitly to resume.

Skills use the same discovery, trust, file expansion, and tool permissions as a skill you invoke directly. A loop cannot invoke another `/loop`. Changing the selected model, workspace, shared folders, or skill pauses future runs so you can confirm the new context by starting again.

Loops are kept only in memory. Archiving or deleting the conversation, signing out, changing accounts or environments, or quitting Desktop clears them. Unarchiving, signing in, and restarting the app never resume a loop automatically. Composer drafts are not sent by a loop.
