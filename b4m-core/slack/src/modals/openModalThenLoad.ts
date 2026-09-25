import type { View, WebClient } from '@slack/web-api';

function placeholderView(title: string, text: string): View {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

/**
 * Open a loading modal, then swap in the real view once `build` resolves.
 * A trigger_id expires 3s after the click, so views.open cannot wait on slow
 * work like the model listing; views.update has no such window. If `build`
 * throws, the modal shows an error instead of spinning forever, and the error
 * is rethrown for the caller to log.
 */
export async function openModalThenLoad(
  client: WebClient,
  triggerId: string,
  title: string,
  build: () => Promise<View>
): Promise<void> {
  const opened = await client.views.open({
    trigger_id: triggerId,
    view: placeholderView(title, ':hourglass_flowing_sand: Loading...'),
  });
  const viewId = opened.view?.id;
  if (!viewId) throw new Error('views.open returned no view id');

  let view: View;
  try {
    view = await build();
  } catch (error) {
    await client.views
      .update({
        view_id: viewId,
        view: placeholderView(title, ':warning: Failed to load. Please close and try again.'),
      })
      .catch(() => {});
    throw error;
  }
  // hash makes Slack reject the update if the view changed since it was opened.
  await client.views.update({ view_id: viewId, hash: opened.view?.hash, view });
}
