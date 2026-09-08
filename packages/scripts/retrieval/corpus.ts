/**
 * The retrieval-recall probe corpus (#1993): a fixed question set with hand-authored ground truth.
 *
 * WHY THE HELP LAKE. The probe needs a real corpus with real embeddings, and this repo is public, so
 * a corpus built from a customer's lake could not be committed - which would make the baseline
 * unreproducible, the exact problem #1831's measurement has today. The `system-help` lake
 * (`packages/scripts/help/ingest-help-datalake.ts`) is the one corpus that is simultaneously real,
 * already vectorized with the deployment's own embedding model, and public: 51 articles under
 * `docs-site/docs/features`, close to the 47-document lake #1831 measured. Seed it into any stage
 * and this file's ground truth applies unchanged.
 *
 * WHY HAND-AUTHORED GROUND TRUTH. #1831 derived its supporting set from an IDF-weighted token proxy
 * over judge-flagged claims and flagged its own 16% as "directional, not precise". A proxy cannot be
 * committed and cannot be audited. Because the corpus is in-repo, the supporting set can simply be
 * stated - and then a config sweep is comparing configurations rather than comparing two runs of an
 * estimator.
 *
 * DESIGN RULES, because an easy question set proves nothing:
 *
 * 1. MOST QUESTIONS NEED SEVERAL DOCUMENTS. This ticket is about the SIZE of what retrieval serves,
 *    so a question one article fully answers cannot discriminate one budget from another - it is
 *    satisfied at every setting. The interesting questions span 2-5 articles.
 * 2. LOW LEXICAL OVERLAP with the article that answers them. A question phrased in the words of its
 *    own document is answerable by keyword matching, and would score a retrieval quality this system
 *    does not have.
 * 3. NEGATIVES ARE NEAR-MISSES, NOT NONSENSE. Each negative sits adjacent to something the corpus
 *    genuinely covers (Salesforce against a corpus full of GitHub/Jira/Confluence/Slack; account
 *    deletion against an article on data retention and "your rights"). A negative nothing resembles
 *    is free to reject. These are the questions the relevance floor exists for, and the only ones
 *    where `falsePositiveRate` can move.
 *
 * TWO SLUGS ARE DELIBERATELY NEVER CITED AS SUPPORTING. `features/overview` is a survey that touches
 * every topic, and `features/common-issues` is a troubleshooting grab-bag; both are plausibly
 * "relevant" to almost any question. Admitting them would inflate recall without retrieval having
 * found anything a reader could use. They stay in the lake as realistic distractors - which is the
 * point - but never in a supporting set.
 */

export type ProbeQuestion = {
  id: string;
  question: string;
  /**
   * Help slugs that genuinely carry material an answer would rest on, as ingested (`help:<slug>`).
   * EMPTY means a negative: nothing in the corpus supports this, and the correct behavior is to
   * serve nothing. Verified against the live corpus by `corpus.test.ts`.
   */
  supporting: string[];
  /** Why this question is hard. Documentation for a future reader; never read by the scorer. */
  note?: string;
};

export const PROBE_QUESTIONS: ProbeQuestion[] = [
  {
    id: 'q01',
    question:
      'Our headcount went from four people to nine last quarter and finance is asking why the monthly charge moved. What drives that number?',
    supporting: ['features/organizations-teams'],
    note: 'Seat-based billing with a 4-seat minimum. Phrased in finance vocabulary ("headcount", "monthly charge") with no overlap on "seat" or "subscription".',
  },
  {
    id: 'q02',
    question:
      'I want the assistant to answer strictly out of the policy documents my team uploaded, and to show which document each statement came from.',
    supporting: ['features/data-lakes', 'features/knowledge-management'],
    note: 'Spans grounding (data-lakes) and the document/search side (knowledge-management). Avoids the words "lake", "retrieval" and "citation".',
  },
  {
    id: 'q03',
    question: 'What actually happens to a PDF between dropping it in and the assistant being able to use its contents?',
    supporting: ['features/knowledge-management', 'features/data-lakes'],
    note: 'The chunk/embed pipeline. "Vectorize" and "embedding" never appear in the question.',
  },
  {
    id: 'q04',
    question: 'We run everything through Okta. What does the sign-in flow look like for our staff?',
    supporting: ['features/identity-providers'],
    note: 'Single-document positive, kept deliberately: a few of these are needed or the set cannot show that narrow questions stay narrow as the budget widens.',
  },
  {
    id: 'q05',
    question:
      'In one channel the replies should come from a cheaper model than the rest of the workspace uses. Where is that decided?',
    supporting: ['features/slack-model-config', 'features/integrations/slack-integration'],
    note: 'Channel overrides plus org defaults, and the resolution order between them.',
  },
  {
    id: 'q06',
    question: 'Which of the built-in capabilities can turn a table of numbers into a picture?',
    supporting: ['features/smart-tools'],
    note: 'Data and visualization tools. Deliberately avoids "chart", "graph" and "tool".',
  },
  {
    id: 'q07',
    question: 'I made something in a session and want to hand a colleague outside the company a link to it.',
    supporting: ['features/publish-and-share', 'features/publish-and-share-cookbook', 'features/artifacts-system'],
    note: 'Three documents: the visibility model, the recipes, and what an artifact is. A budget that serves one gets a third of the answer.',
  },
  {
    id: 'q08',
    question:
      'The bot answered fine this morning and now it has gone quiet and mentions being throttled. Where do I start?',
    supporting: [
      'features/integrations/troubleshooting',
      'features/integrations/slack-integration',
      'features/integrations/slack-commands',
    ],
    note: 'Rate limits are documented per-integration AND in the shared troubleshooting article, so a full answer needs both.',
  },
  {
    id: 'q09',
    question:
      'I want to hand over a large piece of work and have it break itself into steps and grind through them without me babysitting each one.',
    supporting: ['features/quest-master', 'features/subagents'],
    note: 'Autonomous planning plus delegation. Phrased with no overlap on "quest", "task" or "agent".',
  },
  {
    id: 'q10',
    question: 'How does it come to remember things about me from one conversation to the next?',
    supporting: ['features/mementos'],
  },
  {
    id: 'q11',
    question: 'We are burning through our allowance faster than expected. What levers exist to bring that down?',
    supporting: ['features/ai-models', 'features/research-mode', 'features/image-processing-generation'],
    note: 'Cost is documented per-feature rather than in one place: model choice, research runs, and image generation each carry their own section. The single hardest recall case in the set.',
  },
  {
    id: 'q12',
    question: 'I have years of conversations in another assistant. Can I bring them across, and what gets lost?',
    supporting: ['features/chat-history-import'],
  },
  {
    id: 'q13',
    question:
      'What do I need to switch on before someone can hold a spoken conversation with it, and what does that cost?',
    supporting: ['features/voice-v2'],
    note: 'Admin setup and credits live in the same article; a narrow question that should stay narrow.',
  },
  {
    id: 'q14',
    question:
      'We have our own model running behind our firewall. Can it be pointed at that instead of the usual providers?',
    supporting: ['features/private-model-hub', 'features/ai-models'],
    note: 'Private hub plus the custom-key section of the model article.',
  },
  {
    id: 'q15',
    question: 'My generated interface renders blank and the browser console complains about a blocked script.',
    supporting: ['features/react-artifacts-csp', 'features/artifacts-system'],
    note: 'CSP constraints plus artifact troubleshooting.',
  },
  {
    id: 'q16',
    question: 'How do I get a line break in the box without firing off the message?',
    supporting: ['features/keyboard-shortcuts', 'features/notebooks'],
    note: 'Documented in both the dedicated shortcuts article and the notebook article - a genuine two-document fact.',
  },
  {
    id: 'q17',
    question: 'What usage information is gathered about me, what is deliberately left out, and can I decline?',
    supporting: ['features/context-telemetry'],
  },
  {
    id: 'q18',
    question: 'I am juggling three client engagements and want each one to keep its own files and sessions apart.',
    supporting: ['features/projects'],
  },
  {
    id: 'q19',
    question: 'I want a named assistant with a fixed brief and manner that my team can call on.',
    supporting: ['features/agents', 'features/tavern'],
    note: 'Agent creation plus the surface agents are created on.',
  },
  {
    id: 'q20',
    question: 'Can I get a copy of a session out of the product in a form I could put in version control?',
    supporting: ['features/notebook-export-import'],
  },
  {
    id: 'q21',
    question: 'When a pull request opens, the right people should hear about it where they already work.',
    supporting: ['features/github-slack-notifications', 'features/integrations/github-webhooks'],
    note: 'Subscription management plus the event plumbing underneath. No overlap on "notification" or "webhook".',
  },
  {
    id: 'q22',
    question: 'Which permissions does the connector ask my administrator to grant, and what does it do with them?',
    supporting: [
      'features/integrations/github-integration',
      'features/integrations/jira-integration',
      'features/integrations/confluence-integration',
      'features/integrations',
    ],
    note: 'Deliberately unscoped to one vendor: every integration article carries its own scopes section plus the shared matrix. Tests breadth across near-identical documents, which is where ranking crowds one source out.',
  },
  {
    id: 'q23',
    question: 'Is there a way to drive this from a terminal as part of a build?',
    supporting: ['features/tavern/cli'],
  },
  {
    id: 'q24',
    question:
      'I want it to go away and read broadly around a topic before writing anything, and to tell me what it read.',
    supporting: ['features/research-mode', 'features/research-engine'],
    note: 'Two adjacent articles that are easy to conflate; a shallow retrieval returns one and reads as complete.',
  },
  {
    id: 'q25',
    question: 'Where do I go to see and revoke the tokens my account has handed out to other systems?',
    supporting: ['features/profile-settings'],
  },

  // --- Negatives: nothing in the corpus supports these. See design rule 3. ---
  {
    id: 'n01',
    question:
      'How do I sync our customer records from Salesforce so the assistant can answer questions about accounts?',
    supporting: [],
    note: 'Near-miss: the corpus documents GitHub, Jira, Confluence and Slack connectors at length. "Salesforce" appears nowhere in it.',
  },
  {
    id: 'n02',
    question:
      'We need to run this inside an air-gapped network with no outbound connectivity. What is the on-premise install path?',
    supporting: [],
    note: 'Near-miss: the corpus covers private model endpoints and identity federation, which sound adjacent. No self-hosting or air-gap material exists in it.',
  },
  {
    id: 'n03',
    question: 'I want my account permanently deleted along with everything it ever stored. How do I trigger that?',
    supporting: [],
    note: 'The strongest near-miss in the set: the telemetry article has "Data Retention" and "Your Rights" sections that a floor set too low will happily serve as if they answered this.',
  },
  {
    id: 'n04',
    question: 'Is there a browser extension that lets me use this on any page I am reading?',
    supporting: [],
    note: 'Near-miss to the integrations family. No extension is documented anywhere in the corpus.',
  },
  {
    id: 'n05',
    question: 'Can it produce a two-host podcast episode with distinct voices from a document I give it?',
    supporting: [],
    note: 'Near-miss: the corpus documents spoken conversation (voice) and image generation, so both halves sound covered. Podcast generation is not.',
  },
];

/** Questions with a non-empty supporting set. */
export const POSITIVES = PROBE_QUESTIONS.filter(q => q.supporting.length > 0);

/** Questions nothing in the corpus supports - scored by falsePositiveRate, not recall. */
export const NEGATIVES = PROBE_QUESTIONS.filter(q => q.supporting.length === 0);

/**
 * Every slug this ground truth depends on. `corpus.test.ts` asserts each one is a real public help
 * article, so a docs rename cannot silently turn a supporting document into an unreachable one and
 * depress recall for a reason that has nothing to do with retrieval.
 */
export const REFERENCED_SLUGS = [...new Set(PROBE_QUESTIONS.flatMap(q => q.supporting))].sort();

/**
 * Survey/grab-bag articles that stay in the lake as distractors but are never ground truth. Asserted
 * absent from every supporting set by `corpus.test.ts`, so the exclusion cannot erode as questions
 * are added later.
 */
export const NEVER_SUPPORTING = ['features/overview', 'features/common-issues'] as const;
