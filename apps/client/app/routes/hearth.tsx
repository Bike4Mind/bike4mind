import HearthChannelsView from '@client/app/components/hearth/HearthChannelsView';

/**
 * Hearth home - the minimal channel view over the shared append-only event
 * log (/api/hearth/*). Chat here is one projection of the log; the same
 * events feed the CLI's hearth_* tools and future gateway surfaces.
 */
export default function HearthHome() {
  return <HearthChannelsView />;
}
