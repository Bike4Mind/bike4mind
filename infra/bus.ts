// Event Bus resource definition (no dependencies on queues to avoid circular imports)
const eventBus = new sst.aws.Bus('AppEventBus');

export { eventBus };
