import { describe, expect, it } from 'vitest';
import {
  INVITE_CENTER_SEARCH_PARSERS,
  INVITE_CENTER_SECTION_IDS,
  INVITE_CENTER_SECTION_PARAM,
  INVITE_CENTER_TAB_PARAMS,
  PENDING_ACTIVE_DAYS,
  PENDING_ACTIVE_DAYS_PARAM,
  PENDING_INVITE_PARAM,
  PENDING_SORT_PARAM,
  PENDING_STATUS_PARAM,
} from './inviteCenterSearch';

const parseSection = INVITE_CENTER_SEARCH_PARSERS[INVITE_CENTER_SECTION_PARAM];

describe('invite center section parser', () => {
  it.each(INVITE_CENTER_SECTION_IDS)('accepts %s', id => {
    expect(parseSection(id)).toBe(id);
  });

  it.each([undefined, '', 'nope', 'constructor', 'toString', 1])('drops %s', value => {
    expect(parseSection(value)).toBeUndefined();
  });

  it('registers the section and the pending filter params, each once', () => {
    expect(INVITE_CENTER_TAB_PARAMS).toEqual([
      INVITE_CENTER_SECTION_PARAM,
      'pendingStatus',
      'pendingReason',
      'pendingSource',
      'pendingInvite',
      'pendingActiveDays',
      'pendingSort',
      'heldGrants',
    ]);
    expect(Object.keys(INVITE_CENTER_SEARCH_PARSERS).sort()).toEqual([...INVITE_CENTER_TAB_PARAMS].sort());
  });

  it('coerces pending filters to their known values', () => {
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_STATUS_PARAM]('held')).toBe('held');
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_STATUS_PARAM]('released')).toBeUndefined();
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_SORT_PARAM]('remaining')).toBe('remaining');
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_INVITE_PARAM]('invited')).toBe('invited');
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_INVITE_PARAM]('uninvited')).toBe('uninvited');
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_INVITE_PARAM]('maybe')).toBeUndefined();
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_INVITE_PARAM]('')).toBeUndefined();
    expect(INVITE_CENTER_SEARCH_PARSERS.heldGrants('open')).toBe('open');
    expect(INVITE_CENTER_SEARCH_PARSERS.heldGrants('closed')).toBeUndefined();
  });

  it('accepts the activity presets and drops other values', () => {
    const parse = INVITE_CENTER_SEARCH_PARSERS[PENDING_ACTIVE_DAYS_PARAM];
    for (const days of PENDING_ACTIVE_DAYS) expect(parse(days)).toBe(days);
    for (const value of [undefined, '', '0', '91', '2.5', 'week', 7]) expect(parse(value)).toBeUndefined();
  });
});
