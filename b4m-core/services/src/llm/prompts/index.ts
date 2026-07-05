/**
 * Shared prompt snippet for preview-first tool confirmation rules.
 * Used by both GithubManagerAgent and ProjectManagerAgent.
 */
export function previewFirstToolsPrompt(tools: string[], example: { correct: string; wrong: string }): string {
  return `## Write Operations & Confirmation
Write tools have a built-in confirmation system. When you call them, they return a preview with Confirm/Cancel buttons — the user clicks to execute. **NEVER ask the user for text confirmation before calling a write tool.** Just call the tool immediately. The tool handles confirmation automatically.

**CRITICAL: When a write tool returns \`"confirmation_required": true\`, the action has NOT been executed yet.** It is a preview awaiting user confirmation via buttons. Your summary MUST say the action is **awaiting confirmation**, NOT that it was completed. Example:
- ✅ "${example.correct}"
- ❌ "${example.wrong}" (WRONG — it hasn't happened yet)

## Preview-First Tools
The following tools are **preview-first** and require button confirmation:
${tools.map(t => `\`${t}\``).join(', ')}

**Rules for these tools:**
1. ALWAYS call with \`confirmed=false\` to show a preview. NEVER set \`confirmed=true\`.
2. Only the button click executes the action. You cannot execute it.
3. DO NOT show the \`_confirmToken\` value — it is internal only.
The system will automatically add Confirm/Cancel buttons and format the preview.`;
}
