import { describe, expect, it } from 'vitest';
import { generateTranscriptMarkdown } from './markdownGenerator';

describe('generateTranscriptMarkdown', () => {
  // A b4m_map fence refers to places by id only, resolved against the turn's own citables - the
  // curated transcript must thread promptMeta.citables through, or a map reply silently loses its
  // place list in the one export explicitly meant to be a complete record (#3250 follow-up).
  it('resolves a b4m_map fence using the message promptMeta citables, dropping an unresolved id', () => {
    const session = { name: 'Trip planning', firstCreated: '2024-01-01', lastUpdated: '2024-01-02' };
    const messages = [
      {
        timestamp: '2024-01-01T00:00:00Z',
        prompt: 'restaurants near my hotel',
        reply:
          'Here are some options.\n\n```b4m_map\n{"places":[{"id":"place-1","name":"Barr"},{"id":"invented","name":"Fake"}]}\n```\n',
        promptMeta: {
          citables: [
            {
              id: 'place:place-1',
              type: 'web_url',
              title: 'Barr',
              metadata: { place: { id: 'place-1', name: 'Barr', lat: 55.67, lng: 12.57 } },
            },
          ],
        },
      },
    ];

    const md = generateTranscriptMarkdown(session, messages, [], { includeMetadata: false });

    expect(md).toContain('Barr');
    expect(md).toContain('Open in Google Maps');
    expect(md).not.toContain('Fake');
    expect(md).not.toContain('invented');
    expect(md).not.toContain('b4m_map');
  });
});
