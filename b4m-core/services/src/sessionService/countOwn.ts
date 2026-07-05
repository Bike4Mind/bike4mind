interface CountOwnSessionsAdapters {
  db: {
    sessions: {
      countByUserId: (userId: string) => Promise<number>;
    };
  };
}

export const countOwnSessions = async (userId: string, { db }: CountOwnSessionsAdapters) => {
  const count = await db.sessions.countByUserId(userId);
  return { count };
};
