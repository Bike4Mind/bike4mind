import type { ILoop, ILoopStageConfig } from './LoopTypes';

/**
 * A prefill for the new-loop form, shaped like the part of `ILoop` the form reads. It sets no model,
 * hand-offs, triggers or overseen loops: those are the owner's, and `setupNotes` names them. The loop it
 * creates is a draft like any other.
 */
export interface ILoopTemplate extends Pick<
  ILoop,
  'name' | 'goal' | 'intervalMinutes' | 'tools' | 'stages' | 'wakeMode'
> {
  id: string;
  summary: string;
  stageConfig: ILoopStageConfig[];
  setupNotes: string[];
}

// Instructions never say "move the ticket to <next stage>": a completed run already advances its ticket
// (`advancePatch` in loops/tickets.ts). A run moves its ticket only to send it somewhere else.
// No template sets a daily budget: admission needs the budget left to cover one run priced at a full reply on the
// owner's model (`loopAdmission` in apps/client/server/utils/loopBudget.ts), which no single default fits.
const BUDGET_NOTE =
  'Set a daily budget before you set it live. If it is too small for one run on your model, the loop pauses and ' +
  'says how much it needs.';

const OWNER_APPROVAL =
  'Before anything outward-facing (posting, publishing, merging, emailing, spending), set the ticket blocked with ' +
  'loop_ticket_update and the reason "Needs owner approval: <what and why>", then stop.';

export const LOOP_TEMPLATES: readonly ILoopTemplate[] = [
  {
    id: 'software-factory',
    name: 'Software factory',
    summary: 'Refines tickets, builds them on your Desktop and opens pull requests for your review.',
    goal:
      'Turn tickets into reviewed pull requests for one repository. Work one ticket at a time, keep each change ' +
      'small, and never merge: a person reviews and merges every pull request.',
    intervalMinutes: 60,
    tools: [],
    stages: ['readiness', 'refine', 'build', 'open-pr', 'review', 'done'],
    wakeMode: 'interval',
    stageConfig: [
      {
        stage: 'readiness',
        runner: 'desktop',
        mergePolicy: 'review',
        instructions:
          'Check the repository is safe for unattended work, using gh: (1) the default branch is protected ' +
          '(gh api repos/{owner}/{repo}/branches/{branch}/protection); (2) protection requires at least one CI ' +
          'status check; (3) preview deploys work (the latest merged pull request has a successful deployment or ' +
          'preview check). If any check fails, set the ticket blocked with loop_ticket_update and list exactly what ' +
          'is missing, and do no other work. If all pass, just end the run.',
      },
      {
        stage: 'refine',
        instructions:
          'Rewrite the ticket into a small, testable task with acceptance criteria. Take docs-only and read-only ' +
          'tickets first. Until the owner has merged at least one pull request from this loop, set each feature ' +
          'ticket blocked with loop_ticket_update and the reason "Feature work waits for your first merged pull ' +
          'request from this loop". ' +
          OWNER_APPROVAL,
      },
      {
        stage: 'build',
        runner: 'desktop',
        mergePolicy: 'review',
        instructions:
          'Implement the ticket on a new branch. Run the tests for the code you touched and fix failures. If you ' +
          'cannot make them pass, block the ticket with what fails. Do not push yet.',
      },
      {
        stage: 'open-pr',
        runner: 'desktop',
        mergePolicy: 'review',
        instructions:
          'Push the branch and open a pull request that explains the change and how it was tested. Never merge it. ' +
          'Put the pull request link on the ticket.',
      },
      {
        stage: 'review',
        instructions:
          'Read the pull request, its CI checks and review comments through the GitHub tools. If CI fails or a ' +
          'reviewer asked for changes, put the details on the ticket and move it back to build with ' +
          'loop_ticket_update. If the pull request is still waiting on CI or a reviewer, set ' +
          'the ticket status open with loop_ticket_update so it stays here for the next run. Once it is merged, just ' +
          'end the run. Never merge or approve it yourself.',
      },
    ],
    setupNotes: [
      'Set Repo on the readiness, build and open-pr stages; keep their merge policy at Review required.',
      'Those stages run on your Desktop app, so it must be online with gh signed in.',
      'Add your GitHub MCP tools to the loop so the review stage can read pull requests.',
      BUDGET_NOTE,
    ],
  },
  {
    id: 'backlog-refinement',
    name: 'Backlog refinement',
    summary: 'Reads your issue tracker, removes duplicates, sets priorities and writes acceptance criteria.',
    goal:
      'Keep the backlog ready to build. Read new issues from the tracker, merge duplicates, set a priority from p0 ' +
      'to p3, and write clear acceptance criteria. Hand ready tickets to the factory loop.',
    intervalMinutes: 240,
    tools: [],
    stages: ['intake', 'refine', 'ready', 'done'],
    wakeMode: 'interval',
    stageConfig: [
      {
        stage: 'intake',
        instructions:
          'Read open issues through the tracker tools and file one ticket per issue not already tracked here, with ' +
          'loop_ticket_create and stage "refine". If two issues describe the same problem, file one ticket that ' +
          'links both.',
      },
      {
        stage: 'refine',
        instructions:
          'Set a priority (p0 to p3) and write acceptance criteria a builder can check. If the issue is unclear, ' +
          'block the ticket with the question for the owner. Do not edit or close issues in the tracker. ' +
          OWNER_APPROVAL,
      },
      {
        stage: 'ready',
        instructions:
          'Hand the ticket to the factory loop with loop_ticket_handoff. If no hand-off target is set, block the ' +
          'ticket and say so.',
      },
    ],
    setupNotes: [
      'Connect your tracker (GitHub, Linear or Jira) as an MCP server and add its tools to the loop.',
      'Pick your factory loop under Hand off to.',
      BUDGET_NOTE,
    ],
  },
  {
    id: 'white-box-review',
    name: 'White-box review',
    summary: 'Reads the code for untested paths and risky changes, then writes the missing tests on your Desktop.',
    goal:
      'Find code that is risky and untested, and add tests for it. Look at recent changes first. One ticket per ' +
      'gap, each small enough to test in one run.',
    intervalMinutes: 1440,
    tools: [],
    stages: ['scan', 'test', 'done'],
    wakeMode: 'interval',
    stageConfig: [
      {
        stage: 'scan',
        instructions:
          'Read the repository through the GitHub tools: recent merged changes, then the code they touch. For each ' +
          'path with no test that could break users, file one ticket with loop_ticket_create and stage "test", ' +
          'naming the file, the behavior to test and why it is risky. Skip paths that already have a ticket.',
      },
      {
        stage: 'test',
        runner: 'desktop',
        mergePolicy: 'review',
        instructions:
          'Write the tests the ticket asks for and run them. Do not change the code under test; if a test shows a ' +
          'bug, block the ticket with the failing test and what it shows. ' +
          OWNER_APPROVAL,
      },
    ],
    setupNotes: [
      'Add your GitHub MCP tools to the loop so scan can read the code.',
      'Set Repo on the test stage. It runs on your Desktop app, so it must be online.',
      BUDGET_NOTE,
    ],
  },
  {
    id: 'black-box-walk',
    name: 'Black-box walk',
    summary:
      'Walks your live app as synthetic users and files what breaks. The walk runs on your Desktop; the server has no browser.',
    goal:
      'Use the app the way real users do and report what gets in their way. App URL: <put the URL here>. Never ' +
      "enter real payment details or change other users' data.",
    intervalMinutes: 1440,
    tools: ['web_fetch'],
    stages: ['plan', 'walk', 'report', 'done'],
    wakeMode: 'interval',
    stageConfig: [
      {
        stage: 'plan',
        instructions:
          'If the goal still says <put the URL here>, block the ticket and ask for the app URL, then stop. ' +
          'Otherwise write two or three user personas and, for each, one journey through the app with the steps ' +
          'and what success looks like. File one ticket per journey with loop_ticket_create and stage "walk".',
      },
      {
        stage: 'walk',
        runner: 'desktop',
        mergePolicy: 'review',
        instructions:
          'Walk the journey in the browser tools as the persona. At each step note what you expected and what ' +
          'happened, and take a screenshot of anything wrong. Put the findings on the ticket. ' +
          OWNER_APPROVAL,
      },
      {
        stage: 'report',
        instructions:
          'Group the findings and drop duplicates of open tickets. If the loop has a hand-off target, file one ' +
          'ticket per distinct problem in that loop (loop_ticket_create with its loopId), with the steps to ' +
          'reproduce and a priority. Otherwise put that list on this ticket and set it blocked with the reason ' +
          '"Needs owner review: <n> problems found".',
      },
    ],
    setupNotes: [
      'Put the app URL in the goal.',
      'The walk stage runs on your Desktop app (the server has no browser), so it must be online.',
      'Optionally pick a loop under Hand off to (for example backlog refinement) to receive the problems found.',
      BUDGET_NOTE,
    ],
  },
  {
    id: 'release-marketing',
    name: 'Release marketing',
    summary: 'Drafts release notes and media when a release lands, then hands you the package to approve and post.',
    goal:
      "When a release lands, write the What's New text and make media for it, then hand the package to the owner " +
      'for approval. Never post or publish anything; the owner does that.',
    intervalMinutes: 60,
    tools: [],
    stages: ['draft', 'media', 'approve', 'done'],
    wakeMode: 'tickets',
    stageConfig: [
      {
        stage: 'draft',
        instructions:
          "Read what the release changed from the linked ticket and write short What's New text: a headline and " +
          'three bullets a user cares about. Put it on the ticket.',
      },
      {
        stage: 'media',
        tools: ['image_generation', 'audio_generation', 'music_generation'],
        instructions:
          'Make one image for the release and, if it helps, a short voice-over and music bed. Attach links on the ' +
          'ticket.',
      },
      {
        stage: 'approve',
        instructions:
          'Put the text and media together on the ticket, then set it blocked with loop_ticket_update and the ' +
          'reason "Needs owner approval: release post ready". Never post or publish anything. The owner posts the ' +
          'approved package and moves the ticket to done.',
      },
    ],
    setupNotes: [
      "Add a trigger from your factory loop's done stage, so each release files a ticket here.",
      'It only wakes when tickets arrive, so nothing runs until that trigger fires or you file a ticket.',
      'The loop never posts: it stops at approve and you post the approved package yourself.',
      BUDGET_NOTE,
    ],
  },
  {
    id: 'overseer',
    name: 'Overseer',
    summary: 'Watches your other loops, steers them with directives and forecasts their progress.',
    goal:
      'Keep the overseen loops moving. Each run: read loop_oversee_status for every overseen loop; if one is stuck, ' +
      'held or idle with work waiting, steer it with loop_directive_issue, loop_run_now or loop_resume. Write a ' +
      'forecast in memory (for example "loop X clears 4 tickets by tomorrow") and score the previous run\'s forecast ' +
      "against what happened. Never do the overseen loops' work yourself.",
    intervalMinutes: 120,
    tools: [],
    stages: ['watch', 'done'],
    wakeMode: 'interval',
    stageConfig: [],
    setupNotes: ['Pick the loops to watch under Oversees; without them the runs have nothing to read.', BUDGET_NOTE],
  },
  {
    id: 'daily-standup',
    name: 'Daily standup',
    summary: 'Once a day, names the one bottleneck across your loops and proposes one fix.',
    goal:
      'Once a day, read loop_oversee_status for every overseen loop and name the single biggest bottleneck, with ' +
      'numbers: blocked tickets, idle or held loops, spend against budget. Propose one fix by filing a ticket here ' +
      'with loop_ticket_create, status blocked and the reason "Needs owner decision: <the fix>". Never issue a ' +
      'directive, run, resume or change a loop yourself.',
    intervalMinutes: 1440,
    tools: [],
    stages: ['watch', 'done'],
    wakeMode: 'interval',
    stageConfig: [],
    setupNotes: ['Pick the loops to report on under Oversees.', BUDGET_NOTE],
  },
];
