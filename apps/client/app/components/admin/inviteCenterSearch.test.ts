import { describe, expect, it } from 'vitest';
import {
  INVITE_CENTER_SECTION_IDS,
  INVITE_CENTER_SECTION_PARAM,
  INVITE_CENTER_TAB_PARAMS,
  inviteCenterSectionFromParam,
} from './inviteCenterSearch';

describe('inviteCenterSectionFromParam', () => {
  it.each(INVITE_CENTER_SECTION_IDS)('accepts %s', id => {
    expect(inviteCenterSectionFromParam(id)).toBe(id);
  });

  it.each([undefined, '', 'nope', 'constructor', 'toString'])('falls back to waitlist for %s', value => {
    expect(inviteCenterSectionFromParam(value)).toBe('waitlist');
  });

  it('registers only its own param', () => {
    expect(INVITE_CENTER_TAB_PARAMS).toEqual([INVITE_CENTER_SECTION_PARAM]);
  });
});
