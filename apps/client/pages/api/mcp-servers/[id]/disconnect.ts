import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/utils';
import { mcpServerRepository, userRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';

const handler = baseApi().delete(async (req, res) => {
  const { id } = req.query;

  if (typeof id !== 'string') {
    throw new NotFoundError('Server ID is required');
  }

  // Atlassian disconnect is a special case: id is the literal string 'atlassian', not a server _id
  if (id === 'atlassian') {
    await userRepository.update({
      id: req.user.id,
      atlassianConnect: null,
    });

    // Also delete the associated MCP server entirely, not just the user's connect flag
    try {
      const server = await mcpServerRepository.findOne({
        name: McpServerName.Atlassian,
        userId: req.user.id,
      });

      if (server) {
        await mcpServerRepository.delete(server.id);
      }
    } catch (mcpError) {
      console.warn('Failed to delete Atlassian MCP server during unlink:', mcpError);
    }

    res.status(200).json({ success: true });
    return;
  }

  const server = await mcpServerRepository.findOne({
    _id: id,
    userId: req.user.id,
  });

  if (!server) {
    throw new NotFoundError('MCP server not found');
  }

  await mcpServerRepository.delete(id);

  res.status(200).json({ success: true });
});

export default handler;
