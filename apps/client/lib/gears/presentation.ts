/**
 * Gears - code-defined presentation defaults, shared by the Gears page, the
 * status endpoint (admin-override-merged), and the Manage Gears dashboard.
 *
 * `ctaAction` grammar (interpreted by the Gears page):
 *   navigate:<path>     - SPA navigation (path may include a query string)
 *   external:<url>      - window.open in a new tab
 *   files               - open the file-browser drawer
 * Client-claimable stamp gears append `#stamp:<key>` handled by the page.
 */
export interface GearPresentation {
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  ctaAction: string;
}

export const GEAR_PRESENTATION: Record<string, GearPresentation> = {
  // --- Destinations ---
  projects: {
    title: 'Projects',
    tagline: 'One goal, one place',
    intro:
      'Group chats, files, and teammates around a single goal. Everything a project needs stays findable in one workspace.',
    cta: 'Create your first project',
    ctaAction: 'navigate:/projects',
  },
  agents: {
    title: 'Agents',
    tagline: 'Work that runs itself',
    intro:
      'Autonomous workers that carry out multi-step jobs - research, drafting, monitoring - and report back when done.',
    cta: 'Build your first agent',
    ctaAction: 'navigate:/agents',
  },
  datalakes: {
    title: 'Data Lakes',
    tagline: 'Answers from YOUR documents',
    intro:
      'Ground the AI in your own material. Upload documents once; every answer can retrieve and cite your sources first.',
    cta: 'Create your first data lake',
    ctaAction: 'navigate:/data-lakes',
  },
  files: {
    title: 'Files',
    tagline: 'Bring your stuff',
    intro: 'Upload anything - PDFs, spreadsheets, images - and reference it from any chat or project.',
    cta: 'Upload your first file',
    ctaAction: 'files',
  },
  published: {
    title: 'Published',
    tagline: 'Your work, one link',
    intro:
      'Turn any artifact into a shareable web page - public, passphrase-protected, or restricted to email domains you choose.',
    cta: 'See how publishing works',
    ctaAction: 'navigate:/profile?tab=published',
  },
  // --- Skills ---
  image: {
    title: 'Image Generation',
    tagline: 'Paint with a prompt',
    intro: 'Ask any chat to generate or edit an image - concept art, diagrams, marketing shots.',
    cta: 'Generate your first image',
    ctaAction: 'navigate:/new',
  },
  models: {
    title: 'Model Explorer',
    tagline: 'Same question, different minds',
    intro:
      'Switch the AI model mid-conversation - trade speed for depth, or compare answers across providers. Unlocks after chatting on two different models.',
    cta: 'Try another model',
    ctaAction: 'navigate:/new',
  },
  react: {
    title: 'React Artifacts',
    tagline: 'Working apps, not walls of text',
    intro: 'Ask for an interactive React app - a calculator, a dashboard, a game - and run it right in the chat.',
    cta: 'Build a React artifact',
    ctaAction: 'navigate:/new',
  },
  python: {
    title: 'Python Artifacts',
    tagline: 'Real computation, live',
    intro: 'Ask for runnable Python - data crunching, plots, simulations - executed safely in your browser.',
    cta: 'Run some Python',
    ctaAction: 'navigate:/new',
  },
  voice: {
    title: 'Voice',
    tagline: 'Talk it through',
    intro: 'Have the conversation out loud - hands-free chats with any model, transcribed as you go.',
    cta: 'Start a voice chat',
    ctaAction: 'navigate:/new',
  },
  shareproject: {
    title: 'Team Up',
    tagline: 'Better together',
    intro: 'Invite a teammate into a project - shared chats, shared files, shared context.',
    cta: 'Share a project',
    ctaAction: 'navigate:/projects',
  },
  apikey: {
    title: 'API Key',
    tagline: 'Your programmatic handle',
    intro: 'Issue yourself an API key and take Bike4Mind beyond the browser - scripts, integrations, pipelines.',
    cta: 'Issue an API key',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  apicall: {
    title: 'API Call',
    tagline: 'Hello, world',
    intro: 'Make your first API request - one curl with your key and the completions endpoint answers.',
    cta: 'Make your first call',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  forknotebook: {
    title: 'Fork a Notebook',
    tagline: 'Branch the timeline',
    intro:
      'Fork any conversation from any message - explore a what-if without losing the original thread. Find it in the message ... menu.',
    cta: 'Open a notebook to fork',
    ctaAction: 'navigate:/new',
  },
  downloadnotebook: {
    title: 'Download a Notebook',
    tagline: 'Take it with you',
    intro: 'Export a curated notebook as a file - share it, archive it, or read it offline.',
    cta: 'Download a notebook',
    ctaAction: 'navigate:/new',
  },
  questmaster: {
    title: 'Quest Master',
    tagline: 'A mission, not a message',
    intro: 'Hand the AI a multi-step goal - it plans, executes in parallel, and reports back.',
    cta: 'Start your first quest',
    ctaAction: 'navigate:/new',
  },
  mementos: {
    title: 'Mementos',
    tagline: 'It remembers so you do not have to',
    intro: 'Automatic memory across conversations - facts about you and your work, captured and recalled.',
    cta: 'Make a memory',
    ctaAction: 'navigate:/new',
  },
  video: {
    title: 'Video Generation',
    tagline: 'Prompt to motion',
    intro: 'Generate short video from a text prompt, right in the conversation.',
    cta: 'Generate a video',
    ctaAction: 'navigate:/new',
  },
  research: {
    title: 'Research Engine',
    tagline: 'Deep dives, cited',
    intro: 'Multi-source research runs that gather, read, and cite the web for you.',
    cta: 'Run a research task',
    ctaAction: 'navigate:/new',
  },
  rapidreply: {
    title: 'Rapid Reply',
    tagline: 'Answers at the speed of chat',
    intro: 'One-tap AI replies where the conversation already lives.',
    cta: 'Try Rapid Reply',
    ctaAction: 'navigate:/new',
  },
  mcp: {
    title: 'MCP Server',
    tagline: 'Plug in your own tools',
    intro: 'Connect a Model Context Protocol server and give every chat your custom tools.',
    cta: 'Connect an MCP server',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  slack: {
    title: 'Slack',
    tagline: 'B4M where your team talks',
    intro: 'Bring Bike4Mind into Slack - notebooks that live in your channels and threads.',
    cta: 'Chat from Slack',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  importopenai: {
    title: 'Import from ChatGPT',
    tagline: 'Bring your history home',
    intro: 'Import your entire ChatGPT export - every conversation searchable alongside your new work.',
    cta: 'Import ChatGPT history',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  importclaude: {
    title: 'Import from Claude',
    tagline: 'Bring your history home',
    intro: 'Import your Claude export - your past conversations, vectorized and searchable here.',
    cta: 'Import Claude history',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  mfa: {
    title: 'Lock It Down',
    tagline: 'Your account, actually yours',
    intro: 'Turn on two-factor authentication - TOTP with backup codes.',
    cta: 'Enable 2FA',
    ctaAction: 'navigate:/profile?tab=settings',
  },
  shareagent: {
    title: 'Share an Agent',
    tagline: 'Your agent, their hands',
    intro: 'Publish an agent or share it with teammates - expertise that multiplies.',
    cta: 'Share an agent',
    ctaAction: 'navigate:/agents',
  },
  websearch: {
    title: 'Web Search',
    tagline: 'The live internet, in-chat',
    intro: 'Let a conversation search the web for current answers.',
    cta: 'Ask something current',
    ctaAction: 'navigate:/new',
  },
  webfetch: {
    title: 'Web Fetch',
    tagline: 'Read any page',
    intro: 'Pull a specific URL into the conversation and work with its content.',
    cta: 'Fetch a page',
    ctaAction: 'navigate:/new',
  },
  wolfram: {
    title: 'Wolfram Alpha',
    tagline: 'Real math, step by step',
    intro: 'Symbolic math and computational answers with worked steps.',
    cta: 'Compute something',
    ctaAction: 'navigate:/new',
  },
  matheval: {
    title: 'Math Evaluation',
    tagline: 'Numbers you can trust',
    intro: 'Exact calculation in-chat - no LLM arithmetic hallucinations.',
    cta: 'Crunch a number',
    ctaAction: 'navigate:/new',
  },
  clidocs: {
    title: 'Meet the CLI',
    tagline: 'B4M in your terminal',
    intro:
      'A full command-line interface - scripts, pipes, and agents from your shell. Peek at the docs to earn this one.',
    cta: 'Open the CLI docs',
    ctaAction: 'external:https://docs.bike4mind.com/cli/#stamp:clidocs',
  },
};
