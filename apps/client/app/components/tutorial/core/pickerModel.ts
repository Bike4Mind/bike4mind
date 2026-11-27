import {
  TUTORIAL_TRACKS,
  walkIsCurrent,
  type TutorialProgressEntry,
  type TutorialRunModule,
  type TutorialTrack,
} from '@bike4mind/common';

export type PickerStatus = 'not_started' | 'in_progress' | 'finished';

export type PickerGroupKey = TutorialTrack | 'other';

export interface PickerGroup {
  key: PickerGroupKey;
  title: string;
  blurb: string;
  modules: readonly TutorialRunModule[];
}

const GROUP_COPY: Record<PickerGroupKey, { title: string; blurb: string }> = {
  basics: { title: 'The basics', blurb: 'New to AI chat? Start here.' },
  different: { title: 'What is different here', blurb: 'Short tours of what this app does beyond plain chat.' },
  other: { title: 'More tutorials', blurb: 'Everything else you can try.' },
};

/**
 * Where the user stands in a tutorial. A walk saved on an older version of the tutorial cannot be picked up, so it
 * reads as not started; a walk left on the closing card is as good as finished.
 */
export function statusOf(
  tutorial: TutorialRunModule,
  entry: TutorialProgressEntry | undefined,
  liveModuleId?: string | null
): PickerStatus {
  if (liveModuleId === tutorial.id) return 'in_progress';
  if (!entry || !walkIsCurrent(entry, tutorial)) return 'not_started';
  if (entry.status === 'finished') return 'finished';
  const step = tutorial.steps.find(s => s.id === entry.stepId);
  if (entry.status === 'left' && step?.type === 'bridge') return 'finished';
  return 'in_progress';
}

/** The modules by track, in the order the tracks are offered, then any without a track. Empty groups drop out. */
export function groupByTrack(modules: readonly TutorialRunModule[]): PickerGroup[] {
  const keys: readonly PickerGroupKey[] = [...TUTORIAL_TRACKS, 'other'];
  return keys
    .map(key => ({
      key,
      ...GROUP_COPY[key],
      modules: modules.filter(m => (m.track ?? 'other') === key),
    }))
    .filter(group => group.modules.length > 0);
}

/** The tutorial a track continues with: one in progress, else the first not finished, else the first. */
export function nextInTrack(
  modules: readonly TutorialRunModule[],
  progress: Readonly<Record<string, TutorialProgressEntry>> | undefined,
  track: TutorialTrack
): { tutorial: TutorialRunModule; status: PickerStatus } | undefined {
  const inTrack = modules
    .filter(m => m.track === track)
    .map(tutorial => ({ tutorial, status: statusOf(tutorial, progress?.[tutorial.id]) }));
  return inTrack.find(m => m.status === 'in_progress') ?? inTrack.find(m => m.status === 'not_started') ?? inTrack[0];
}
