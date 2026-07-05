import { AGENT_REGISTRY } from '../agent-parser';

/**
 * Generate a help message showing available agents, commands, and tips.
 *
 * This is the canonical implementation used by the system prompt builders
 * to inject help content when the user's intent is classified as "help".
 */
export function generateHelpMessage(): string {
  const agents = Object.entries(AGENT_REGISTRY)
    .map(([key, agent]) => {
      const capabilities = agent.capabilities.slice(0, 3).join(', ');
      return `• *@${key}* - ${agent.description} (${capabilities})`;
    })
    .join('\n');

  return (
    `*Available AI Agents*\n\n${agents}\n\n` +
    `*Example Commands:*\n` +
    `• \`@agent please summarize this thread\`\n` +
    `• \`@pm please create a Jira epic from this conversation\`\n` +
    `• \`@dev please create a GitHub issue for the bug discussed\`\n` +
    `• \`@analyst analyze this week's discussions\`\n` +
    `• \`@researcher find all conversations about [topic]\`\n` +
    `• \`@agent share my latest file\`\n` +
    `• \`@agent list files\` or \`@agent list 10 files\`\n` +
    `• \`@agent share "CuratedFile.md"\`\n\n` +
    `*Curated File Commands:*\n` +
    `• \`list files\` or \`list 5 files\` - Show recent curated files\n` +
    `• \`share latest file\` - Share your most recent curated file\n` +
    `• \`share "Curated File Name"\` - Share a specific curated file by name\n` +
    `• Small files (<10MB): uploaded directly to Slack,  Large files: 7-day download link provided\n\n` +
    `*Image Generation:*\n` +
    `• \`@agent generate an image of a sunset\` — Natural language image generation\n` +
    `• \`@agent draw me a cat with flux-pro\` — Specify a model inline\n` +
    `• Reply in thread to refine: \`Can you add a rainbow?\`\n` +
    `• \`/paint a sunset over mountains\` — Power-user: choose model from picker\n\n` +
    `*Tips:*\n` +
    `• Use "please" for politeness (optional)\n` +
    `• Mention timeframes like "last hour" or "yesterday"\n` +
    `• Add priority with P0, P1, P2, P3\n` +
    `• Assign to people by name\n` +
    `• Say "with images" to include screenshots\n` +
    `• Type \`/help\` to show this help message`
  );
}
