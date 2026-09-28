import { describe, it, expect } from 'vitest';
import { renderOwnershipOfferEmail } from './renderOwnershipOfferEmail';

describe('renderOwnershipOfferEmail', () => {
  it('offered: names the offerer and the expiry', () => {
    const { subject, html } = renderOwnershipOfferEmail({
      kind: 'offered',
      lakeName: 'Lake One',
      counterpartName: 'Olive Owner',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(subject).toContain('Lake One');
    expect(html).toContain('Olive Owner');
    expect(html).toContain('2026-10-01');
  });

  it('accepted: tells the offerer the transfer landed', () => {
    const { subject, html } = renderOwnershipOfferEmail({
      kind: 'accepted',
      lakeName: 'Lake One',
      counterpartName: 'Rita Recipient',
    });
    expect(subject).toContain('accepted');
    expect(html).toContain('Rita Recipient');
    expect(html).toContain('curator');
  });

  it('declined: tells the offerer ownership is unchanged', () => {
    const { subject, html } = renderOwnershipOfferEmail({
      kind: 'declined',
      lakeName: 'Lake One',
      counterpartName: 'Rita Recipient',
    });
    expect(subject).toContain('declined');
    expect(html).toContain('unchanged');
  });

  it('falls back to a role word when the counterpart name is unknown', () => {
    const { html } = renderOwnershipOfferEmail({ kind: 'offered', lakeName: 'Lake One' });
    expect(html).toContain('A teammate');
  });

  it('escapes interpolated names - a lake or user name is user-controlled HTML input', () => {
    const { html, subject } = renderOwnershipOfferEmail({
      kind: 'offered',
      lakeName: '<img src=x onerror=alert(1)>',
      counterpartName: '<script>bad()</script>',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
    // A header cannot be sanitized by HTML-escaping, so CR/LF is stripped from the subject.
    expect(subject).not.toContain('\n');
  });

  it('throws on a kind it does not render, rather than falling through', () => {
    expect(() => renderOwnershipOfferEmail({ kind: 'unknown' as never, lakeName: 'Lake One' })).toThrow(
      /unhandled kind/i
    );
  });
});
