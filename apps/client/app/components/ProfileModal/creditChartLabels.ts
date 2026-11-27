/**
 * Display name for a Credits chart series id. Add a case when a chart series is added; unknown ids fall back to
 * the generic credits label. `t` is the i18n function of the caller.
 */
export const getCreditSeriesLabel = (seriesId: string, t: (key: string) => string): string => {
  switch (seriesId) {
    case 'purchases':
      return 'Purchases';
    case 'subscriptions':
      return 'Subscriptions';
    case 'generic_add':
      return 'Generic Credits Added';
    case 'referral_rewards':
      return 'Referral rewards';
    case 'generic_deduct':
      return 'Generic Credits Deducted';
    case 'text_usage':
      return 'Text Generation';
    case 'completion_api_usage':
      return 'Completion API Usage';
    case 'image_usage':
      return 'Image Generation';
    case 'image_edit_usage':
      return 'Image Editing';
    case 'voice_usage':
      return 'Voice Usage';
    case 'tool_usage':
      return 'Tool Usage';
    case 'speech_to_text_usage':
      return 'Speech to Text';
    case 'text_to_speech_usage':
      return 'Text to Speech';
    case 'sound_effects_usage':
      return 'Sound Effects';
    case 'music_generation_usage':
      return 'Music Generation';
    case 'decision_usage':
      return 'Decisions';
    case 'video_generation_usage':
      return 'Video Generation';
    case 'usage':
      return t('credits.credits_used');
    case 'credits_added':
      return 'Credits Added';
    default:
      return t('credits.credits');
  }
};
