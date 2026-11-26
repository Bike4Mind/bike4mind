import {
  SKILL_TEMPLATE_MAX_INPUTS,
  skillTemplateSlugProblem,
  type ISkillListingTemplate,
  type ISkillTemplateInput,
  type SkillTemplateDraft,
  type SkillTemplateUpdate,
} from '@bike4mind/common';

/** The editor's working copy. Nothing in it is stored until the author saves. */
export type TemplateForm = {
  slug: string;
  headline: string;
  inputs: ISkillTemplateInput[];
  examplePrompt: string;
  /** Set by a draft, a regenerate or "Keep my copy": the save confirms the copy against that version. */
  confirmVersionId: string | null;
};

export const formFromTemplate = (template: ISkillListingTemplate): TemplateForm => ({
  slug: template.slug,
  headline: template.headline,
  inputs: template.inputs.map(({ label, required }) => ({ label, required })),
  examplePrompt: template.examplePrompt,
  confirmVersionId: null,
});

export const EMPTY_DRAFT: SkillTemplateDraft = { headline: '', inputs: [], examplePrompt: '' };

export const formFromDraft = (
  slug: string,
  draft: SkillTemplateDraft,
  generatedFromVersionId: string | null
): TemplateForm => ({
  slug,
  headline: draft.headline,
  inputs: draft.inputs.slice(0, SKILL_TEMPLATE_MAX_INPUTS).map(({ label, required }) => ({ label, required })),
  examplePrompt: draft.examplePrompt,
  confirmVersionId: generatedFromVersionId,
});

/** What is wrong with the link name, or null. A frozen slug is not sent, so it is not checked. */
export const slugProblem = (form: TemplateForm, slugFrozen: boolean): string | null =>
  slugFrozen ? null : skillTemplateSlugProblem(form.slug.trim());

export const inputsProblem = (form: TemplateForm): string | null =>
  form.inputs.some(input => !input.label.trim()) ? 'Give every input a label, or remove it' : null;

/** True when the form differs from the saved template (always true before the first save). */
export function formIsDirty(form: TemplateForm, template: ISkillListingTemplate | null): boolean {
  if (!template) return true;
  const saved = formFromTemplate(template);
  return (
    form.confirmVersionId !== null ||
    form.slug.trim() !== saved.slug ||
    form.headline.trim() !== saved.headline ||
    form.examplePrompt.trim() !== saved.examplePrompt ||
    JSON.stringify(form.inputs.map(i => ({ label: i.label.trim(), required: i.required }))) !==
      JSON.stringify(saved.inputs)
  );
}

/** The PUT body: the slug only while it may change, the version only when the author confirmed it. */
export function formToUpdate(form: TemplateForm, slugFrozen: boolean): SkillTemplateUpdate {
  return {
    ...(slugFrozen ? {} : { slug: form.slug.trim() }),
    headline: form.headline.trim(),
    inputs: form.inputs.map(input => ({ label: input.label.trim(), required: input.required })),
    examplePrompt: form.examplePrompt.trim(),
    ...(form.confirmVersionId ? { generatedFromVersionId: form.confirmVersionId } : {}),
  };
}
