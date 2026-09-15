import QuestGraphView from '@client/app/components/questmaster-v5/QuestGraphView';

/**
 * QuestMaster v5 - the node-graph quest surface. Runs alongside the legacy
 * /quests route (untouched) behind the `enableQuestMasterV5` flag until v5 wins.
 */
export default function QuestMasterV5Page() {
  return <QuestGraphView />;
}
