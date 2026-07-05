// Event Bus resource definition (no dependencies on queues to avoid circular imports)
const eventBus = new sst.aws.Bus('AppEventBus');

// Dedicated event bus for Slack integration events (kept separate from the main bus
// so Slack-specific processing has its own routing, scaling, and IAM surface)
const slackEventBus = new sst.aws.Bus('SlackEventBus');

export { eventBus, slackEventBus };
