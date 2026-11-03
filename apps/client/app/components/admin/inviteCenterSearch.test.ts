import { describe, expect, it } from 'vitest';
import {
  INVITE_CENTER_SEARCH_PARSERS,
  INVITE_CENTER_SECTION_IDS,
  INVITE_CENTER_SECTION_PARAM,
  INVITE_CENTER_TAB_PARAMS,
} from './inviteCenterSearch';

const parseSection = INVITE_CENTER_SEARCH_PARSERS[INVITE_CENTER_SECTION_PARAM];

describe('invite center section parser', () => {
  it.each(INVITE_CENTER_SECTION_IDS)('accepts %s', id => {
    expect(parseSection(id)).toBe(id);
  });

  it.each([undefined, '', 'nope', 'constructor', 'toString', 1])('drops %s', value => {
    expect(parseSection(value)).toBeUndefined();
  });

  it('registers only its own param', () => {
    expect(INVITE_CENTER_TAB_PARAMS).toEqual([INVITE_CENTER_SECTION_PARAM]);
  });
});
