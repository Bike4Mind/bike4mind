import { ApiKeyScope, JupyterCellOutputAction } from '@bike4mind/common';
import { Quest } from '@bike4mind/database/content';
import { Connection } from '@bike4mind/database/social';
import { connectionHoldsScope } from '@server/websocket/connectionScope';
import { withWebSocketContext, sendToClient } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/**
 * WebSocket handler: CLI -> Server -> Web HUD for Jupyter notebook execution progress
 *
 * Receives jupyter_cell_output messages from the CLI during notebook execution.
 * Updates the Quest document with progress and relays the output to the user's
 * web clients for real-time display.
 *
 * Authentication: The CLI's connection was verified during $connect.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: ReturnType<typeof JupyterCellOutputAction.parse>;
  try {
    body = JupyterCellOutputAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[JUPYTER_OUTPUT] Failed to parse output body:', parseError);
    return { statusCode: 200 };
  }

  const { sessionId, cellIndex, outputType, content, isComplete } = body;

  // Verify the sender has a valid connection
  const connection = await Connection.findOne({ connectionId });
  if (!connection) {
    logger.error(`[JUPYTER_OUTPUT] Unknown connectionId: ${connectionId}`);
    return { statusCode: 200 };
  }

  // This frame mutates notebook execution state, which notebooks:write is the scope for. A socket
  // opened with a narrower key has no authority here - notably cc-bridge:connect, which is enough
  // to pass $connect on its own. A key holding notebooks:write alongside one of the three connect
  // scopes still passes, which is the intended shape: the gate narrows the credential, it does not
  // ban API keys from the action.
  if (!connectionHoldsScope(connection, [ApiKeyScope.WRITE_NOTEBOOKS])) {
    logger.warn(`[JUPYTER_OUTPUT] Connection ${connectionId} lacks notebooks:write - dropping cell output`);
    return { statusCode: 200 };
  }

  const userId = connection.userId;
  logger.info(`[JUPYTER_OUTPUT] Cell ${cellIndex} output (type: ${outputType}, complete: ${isComplete})`);

  // Owner-scoped: sessionId is caller-supplied, so without this predicate any authenticated
  // socket could drive another user's notebook execution state. `promptMeta.session.userId` is
  // the quest's owner field - the Quest schema has no top-level `userId` (see the note in
  // pages/api/jupyter/execute.ts).
  const quest = await Quest.findOne(
    {
      sessionId,
      'promptMeta.session.userId': userId,
      'jupyterNotebook.status': { $in: ['generating', 'executing'] },
    },
    {},
    { sort: { timestamp: -1 } }
  );

  // Determine the WebSocket status to send (must match UI expectations: 'executing', 'completed', 'failed')
  let wsStatus: 'executing' | 'completed' | 'failed' = 'executing';

  if (quest) {
    // Update quest with cell execution progress
    const updateData: Record<string, unknown> = {
      'jupyterNotebook.executedCells': cellIndex + (isComplete ? 1 : 0),
    };

    // If this is an error output, record it and mark as failed
    if (outputType === 'error' && content.ename) {
      updateData['jupyterNotebook.lastError'] = `${content.ename}: ${content.evalue}`;
      updateData['jupyterNotebook.status'] = 'failed';
      updateData['jupyterNotebook.completedAt'] = new Date();
      wsStatus = 'failed';
    }

    // If cell is complete and was successful, potentially update status
    if (isComplete && outputType !== 'error') {
      // Check if this was the last cell
      const jupyterState = quest.jupyterNotebook;
      if (jupyterState && jupyterState.cellCount && cellIndex + 1 >= jupyterState.cellCount) {
        updateData['jupyterNotebook.status'] = 'completed';
        updateData['jupyterNotebook.completedAt'] = new Date();
        wsStatus = 'completed';
      }
    }

    // Re-assert ownership on the write, not just the read: the quest was selected under the
    // caller's own predicate, so this only closes the gap between the two queries.
    await Quest.findOneAndUpdate({ _id: quest._id, 'promptMeta.session.userId': userId }, { $set: updateData });
  }

  // Relay the cell output to web clients only for real-time display
  // Filter out CLI connections to avoid echoing progress back to the sender
  await sendToClient(
    userId,
    endpoint,
    {
      action: 'jupyter_notebook_progress',
      questId: quest?._id?.toString() ?? '',
      sessionId,
      status: wsStatus,
      cellIndex,
      totalCells: quest?.jupyterNotebook?.cellCount,
      output: content,
      error: outputType === 'error' ? `${content.ename}: ${content.evalue}` : undefined,
    },
    { sourceFilter: 'web' }
  );

  return { statusCode: 200 };
});
