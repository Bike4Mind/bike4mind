---
title: Rapid Reply
description: Get instant acknowledgments while your full AI response is being prepared
sidebar_position: 20
tags: [chat, performance, experimental]
---

# Rapid Reply

*(Experimental Feature — enable in [Profile > Settings > Experimental Features](./profile-settings.md#experimental-features))*

Rapid Reply reduces the perceived wait time in AI conversations by showing you an instant acknowledgment while your full response is being generated.

> **Availability:** This feature may be enabled or disabled at the organizational level by your administrator. If the toggle is grayed out with "Disabled by administrator," contact your organization admin to request access.

---

## How It Works

When you send a message with Rapid Reply enabled:

1. A **fast mini model** immediately generates a short acknowledgment (one sentence) based on your prompt
2. The acknowledgment appears instantly in the chat — for example: "Working through that code now!"
3. Your **full response** from the selected model streams in below as it is generated

This gives you immediate visual feedback that the AI is working on your request, which is especially helpful with larger models that take a few seconds before the first token appears.

## How to Enable

1. Click your **avatar** in the sidebar footer to open your Profile
2. Go to the **Settings** tab
3. Scroll to **Experimental Features**
4. Toggle **Rapid Reply** on

The feature activates automatically in your chat sessions. No additional configuration is needed — the system selects an appropriate fast model for the acknowledgment based on your primary model.

---

## Related Features

- [Notebooks](./notebooks.md) - Where Rapid Reply appears
- [AI Models](./ai-models.md) - Models that power responses
- [Profile & Settings](./profile-settings.md) - Where you enable this feature
