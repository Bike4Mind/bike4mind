import { describe, it, expect } from 'vitest';
import { GEAR_PRESENTATION } from '@client/lib/gears/presentation';
import { gearDetailFor } from './detail';

const itemFor = (key: string) => ({ key, intro: GEAR_PRESENTATION[key].intro });

describe('gearDetailFor', () => {
  it('gives a feature with no copy yet its intro and nothing invented', () => {
    const item = itemFor('apikey');
    const detail = gearDetailFor(item);

    // `authored` is what the view keys its "in progress" notice on, so a feature
    // that quietly reported true would show an empty page instead.
    expect(detail.authored).toBe(false);
    expect(detail.whatItDoes).toBe(item.intro);
    expect(detail.whyItWorks).toBeUndefined();
    expect(detail.whenToUse).toBeUndefined();
    expect(detail.gotchas).toBeUndefined();
  });

  it('prefers the authored copy where it exists', () => {
    const detail = gearDetailFor(itemFor('mementos'));

    expect(detail.authored).toBe(true);
    expect(detail.whatItDoes).toContain('Mementos are short facts');
    expect(detail.gotchas).toBeTruthy();
  });
});
