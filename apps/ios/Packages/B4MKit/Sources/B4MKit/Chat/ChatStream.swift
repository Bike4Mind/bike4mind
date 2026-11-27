import Foundation

/// Chat streaming frames out of the realtime event stream.
///
/// Frames are sent per USER, not per session: every open screen sees every quest the user runs, so
/// each consumer filters by session (or quest) id.
public enum ChatStream {
  /// The chat frame in `event`, if it is one for `sessionID` (any session when `nil`).
  public static func frame(in event: RealtimeEvent, sessionID: String?) -> ChatQuestFrame? {
    guard case .frame(let action) = event, let frame = ChatQuestFrame(action) else { return nil }
    if let sessionID, frame.sessionID != sessionID { return nil }
    return frame
  }

  /// Chat frames for one session (or all sessions when `nil`). Every other action, known or not, is
  /// skipped. Ends when the realtime client's event stream ends or the consumer stops iterating.
  public static func updates(from realtime: any RealtimeClient, sessionID: String?) async -> AsyncStream<ChatQuestFrame>
  {
    let events = await realtime.events()
    return AsyncStream { continuation in
      let task = Task {
        for await event in events {
          if let frame = frame(in: event, sessionID: sessionID) { continuation.yield(frame) }
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
