import { describe, expect, it } from 'vitest';
import { STATUS_TEMPLATES, TEMPLATE_IDS, renderTemplate } from './templates';
import { validatePublicText } from './textPolicy';

const full = { component: 'Chat', scope: 'some users', workaround: 'Retry in a few minutes.', nextUpdate: '14:30 UTC' };

describe('templates', () => {
  it('offers the eleven built-in templates', () => {
    expect([...TEMPLATE_IDS].sort()).toEqual(Object.keys(STATUS_TEMPLATES).sort());
    expect(TEMPLATE_IDS).toHaveLength(11);
  });

  it.each(TEMPLATE_IDS)('%s renders cleanly when every placeholder is filled', id => {
    const rendered = renderTemplate(id, full);
    expect(rendered.unfilled).toEqual([]);
    expect(rendered.text).toContain('Chat');
    expect(validatePublicText('updateBody', rendered.text, { linkHosts: [] }).errors).toEqual([]);
  });

  it('reports unfilled placeholders, and the text policy blocks them', () => {
    const rendered = renderTemplate('investigating', { component: 'Chat' });
    expect(rendered.unfilled.sort()).toEqual(['{nextUpdate}', '{scope}', '{workaround}']);
    const result = validatePublicText('updateBody', rendered.text, { linkHosts: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('unfilled_placeholder');
  });

  it('treats blank values as unfilled', () => {
    expect(renderTemplate('monitoring', { component: '  ', nextUpdate: '' }).unfilled.sort()).toEqual([
      '{component}',
      '{nextUpdate}',
    ]);
  });

  it('does not expand a placeholder that arrives inside a value', () => {
    const rendered = renderTemplate('resolved', { component: '{nextUpdate}', nextUpdate: 'later' });
    expect(rendered.text).toContain('{nextUpdate}');
    expect(rendered.unfilled).toEqual(['{nextUpdate}']);
  });

  it('security variants carry the security classification and name no weakness', () => {
    for (const id of ['security_investigating', 'security_resolved'] as const) {
      const template = STATUS_TEMPLATES[id];
      expect(template.classification).toBe('security');
      const result = validatePublicText('updateBody', renderTemplate(id, full).text, {
        linkHosts: [],
        classification: 'security',
      });
      expect(result.warnings.map(w => w.code)).not.toContain('security_term');
    }
  });

  it('maintenance templates are maintenance kind', () => {
    expect(STATUS_TEMPLATES.maintenance_scheduled.kind).toBe('maintenance');
    expect(STATUS_TEMPLATES.maintenance_complete.status).toBe('completed');
  });
});
