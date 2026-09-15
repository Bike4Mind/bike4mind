import { type MigrationFile } from './index';
import { Session, Quest } from '@bike4mind/database';
import { Types } from 'mongoose';

const migration: MigrationFile = {
  id: 20240524172716,
  name: 'create and populate quests',

  up: async () => {
    // First, add an _id to all existing sessions' chatHistory items
    let sessions = Session.collection.find({ 'chatHistory._id': { $exists: false } });
    let sessionCount = 0;
    let chatHistoryCount = 0;
    for await (const session of sessions) {
      sessionCount++;
      for (const item of session.chatHistory ?? []) {
        if (!item._id) {
          chatHistoryCount++;
          item._id = new Types.ObjectId();
          if (item.timestamp?.toString().match(/^\d{1,2}:\d{2}:\d{2} [AP]M$/)) {
            const [time, period] = item.timestamp.toString().split(' ');
            const [hours, minutes, seconds] = time.split(':').map(Number);
            item.timestamp = new Date();
            item.timestamp.setHours(period === 'PM' ? hours + 12 : hours);
            item.timestamp.setMinutes(minutes);
            item.timestamp.setSeconds(seconds);
          }
        }
      }
      try {
        await Session.updateOne({ _id: session._id }, { chatHistory: session.chatHistory });
      } catch (error: unknown) {
        console.error('Error updating session', session);
        throw error;
      }
    }
    console.log(`Updated ${chatHistoryCount} chatHistory items in ${sessionCount} sessions`);

    // Then upsert each of those documents into the quests collection
    sessions = Session.collection.find({ 'chatHistory._id': { $exists: true } });
    let upserted = 0;
    for await (const session of sessions) {
      for (const item of session.chatHistory) {
        upserted++;
        await Quest.updateOne(
          { _id: item._id },
          {
            $set: {
              sessionId: session._id,
              timestamp: item.timestamp,
              type: item.type,
              prompt: item.prompt,
              reply: item.reply,
              replies: item.replies,
              images: item.images,
              oob: item.oob,
            },
          },
          { upsert: true }
        );
      }
    }
    console.log(`Upserted ${upserted} chatHistory items into quests`);
  },

  down: async () => {
    const sessions = Session.collection.find({ 'chatHistory._id': { $exists: true } });
    // Remove all the quests we created
    await Quest.deleteMany({ sessionId: { $id: sessions.map(s => s._id) } });

    // Remove the _id from all the chatHistory items
    for await (const session of sessions) {
      for (const item of session.chatHistory) {
        delete item._id;
      }
      await session.save();
    }
  },
};

export default migration;
