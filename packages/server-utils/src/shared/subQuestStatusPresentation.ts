// The vocabulary lives in @bike4mind/common so the shared markdown serializer can use it; this path
// stays so apps/workers and apps/client keep importing from one place.
export {
  SUBQUEST_STATUS_ICONS,
  SUBQUEST_STATUS_LABELS,
  getSubQuestStatusIcon,
  getSubQuestStatusLabel,
} from '@bike4mind/common';
