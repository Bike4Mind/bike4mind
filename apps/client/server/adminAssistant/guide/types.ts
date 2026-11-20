/**
 * One admin feature, as the admin assistant explains it. guide.test.ts holds every `views` id to an
 * admin view in VIEW_REGISTRY and every `settings` key to a registered setting.
 *
 * This repo is public: say what an admin sees and does, never how a detector decides or its thresholds.
 */
export type AdminGuideEntry = {
  /** Stable kebab-case id; the assistant cites it. */
  id: string;
  title: string;
  /** What it is and what it is for, in one to three sentences. */
  summary: string;
  /** Admin view ids (VIEW_REGISTRY) where it appears; the first is where to send the admin. */
  views: readonly string[];
  /** Admin setting keys that control it. */
  settings: readonly string[];
  /** How to use it: short steps or facts an admin acts on. */
  howTo: readonly string[];
  /** Other words an admin might search with. */
  keywords: readonly string[];
};
