import { describe, expect, it } from 'vitest';
import { deliveryMailbox } from './deliveryMailbox';

describe('deliveryMailbox', () => {
  it('folds Gmail dots, plus-tags and googlemail.com into one inbox', () => {
    expect(deliveryMailbox('First.Last+promo@googlemail.com')).toBe('firstlast@gmail.com');
  });

  it('folds plus-tags on any domain but keeps dots significant outside Gmail', () => {
    expect(deliveryMailbox('first.last+tag@example.com')).toBe('first.last@example.com');
    expect(deliveryMailbox('first.last@example.com')).not.toBe(deliveryMailbox('firstlast@example.com'));
  });
});
