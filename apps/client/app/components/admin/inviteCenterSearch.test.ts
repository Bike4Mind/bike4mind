import { describe, expect, it } from 'vitest';
import {
  INVITE_CENTER_SEARCH_PARSERS,
  INVITE_CENTER_SECTION_IDS,
  INVITE_CENTER_SECTION_PARAM,
  INVITE_CENTER_TAB_PARAMS,
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
      'pendingSort',
    ]);
    expect(Object.keys(INVITE_CENTER_SEARCH_PARSERS).sort()).toEqual([...INVITE_CENTER_TAB_PARAMS].sort());
  });

  it('coerces pending filters to their known values', () => {
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_STATUS_PARAM]('held')).toBe('held');
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_STATUS_PARAM]('released')).toBeUndefined();
    expect(INVITE_CENTER_SEARCH_PARSERS[PENDING_SORT_PARAM]('remaining')).toBe('remaining');
  });
});
