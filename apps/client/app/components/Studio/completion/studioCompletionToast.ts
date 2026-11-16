import type { StudioCompletionMedium, StudioJobCompletion } from '@bike4mind/common';

export type StudioCompletionToast = {
  tone: 'success' | 'warning' | 'error';
  message: string;
  description?: string;
};

const SINGLE_NOUN: Record<Exclude<StudioCompletionMedium, 'image'>, string> = {
  video: 'Video',
  music: 'Track',
  speech: 'Audio',
  'sound-effects': 'Sound effect',
};

const takes = (count: number) => `${count} ${count === 1 ? 'take' : 'takes'}`;

/** "4 takes ready, Cold brew launch": the toast copy for one finished Studio group. */
export const describeStudioCompletion = (completion: StudioJobCompletion): StudioCompletionToast => {
  const { medium, readyCount, failedCount, title } = completion;
  const attempted = readyCount + failedCount;

  if (medium !== 'image') {
    const noun = SINGLE_NOUN[medium];
    return readyCount > 0
      ? { tone: 'success', message: `${noun} ready, ${title}` }
      : { tone: 'error', message: `${noun} failed, ${title}` };
  }
  if (readyCount === 0) return { tone: 'error', message: `${takes(attempted)} failed, ${title}` };
  if (failedCount === 0) return { tone: 'success', message: `${takes(readyCount)} ready, ${title}` };
  return {
    tone: 'warning',
    message: `${readyCount} of ${takes(attempted)} ready, ${title}`,
    description: `${failedCount} failed`,
  };
};
