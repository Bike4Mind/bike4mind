import remarkGfm from 'remark-gfm';

/**
 * remark-gfm configured with single-tilde strikethrough DISABLED.
 *
 * remark-gfm's `singleTilde` option defaults to true, so a lone `~` that the LLM
 * uses as an "approximately" shorthand (e.g. `~$15M ... ~$40M`) renders the text
 * between two tildes as strikethrough. Disabling it keeps real strikethrough
 * (`~~text~~`) working while leaving single tildes as literal text.
 *
 * Use this in every renderer that displays LLM / AI-generated markdown so the
 * behavior stays consistent and the fix does not drift across surfaces.
 */
export const remarkGfmNoSingleTilde: [typeof remarkGfm, { singleTilde: false }] = [remarkGfm, { singleTilde: false }];
