import Foundation

@testable import B4MKit

/// Response bodies shaped by the OpenAPI schemas (`listSessionsResponse200` and friends in
/// Packages/B4MClient/openapi.json). Both date shapes the server emits appear on purpose.
enum APIFixtures {
  static let sessionsPage1 = """
    {
      "data": [
        {
          "id": "s-new", "_id": "s-new", "name": "Trip planning", "userId": "u1",
          "tags": [{"name": "travel", "strength": 0.9}],
          "lastUsedModel": "claude-sonnet-4",
          "firstCreated": "2026-10-30T08:00:00.123Z",
          "lastUpdated": "2026-10-31T09:30:15.456Z"
        },
        {
          "id": "s-old", "name": "Untitled", "userId": "u1",
          "lastUsedModel": null,
          "firstCreated": "2026-10-01T08:00:00Z",
          "lastUpdated": "2026-10-02T08:00:00Z"
        }
      ],
      "next_cursor": "cursor-2"
    }
    """

  static let sessionsPage2 = """
    {
      "data": [
        {
          "id": "s-oldest", "name": "Recipes", "userId": "u1",
          "firstCreated": "2026-09-01T08:00:00.000Z", "lastUpdated": "2026-09-02T08:00:00.000Z"
        }
      ],
      "next_cursor": null
    }
    """

  /// Done turn, running turn, tool awaiting approval, failed turn out of credits, and a legacy turn
  /// with no status or type.
  static let quests = """
    {
      "data": [
        {
          "id": "q1", "prompt": "Hello", "reply": "Hi **there**", "status": "done", "type": "message",
          "createdAt": "2026-10-31T09:00:00.000Z", "creditsUsed": 12.5
        },
        {
          "id": "q2", "prompt": "Search the web", "reply": null, "status": "running", "type": "message",
          "createdAt": "2026-10-31T09:01:00.000Z"
        },
        {
          "id": "q3", "prompt": "Delete the file", "reply": "", "status": "pending", "type": "message",
          "createdAt": "2026-10-31T09:02:00.000Z",
          "pendingAction": {"tool": "file_delete", "params": {"path": "/tmp/a.txt", "force": true}, "ts": 1793437320000}
        },
        {
          "id": "q4", "prompt": "Write a novel", "reply": "Not enough credits.", "status": "stopped", "type": "error",
          "errorCode": "insufficient_credits", "createdAt": "2026-10-31T09:03:00.000Z"
        },
        {
          "id": "q5", "prompt": null, "reply": "Legacy reply", "createdAt": "2026-10-31T09:04:00Z"
        }
      ],
      "next_cursor": null
    }
    """

  static let credits = #"{"balance": 31667}"#
  static let errorBody = #"{"error": "nope", "request_id": "abc-123"}"#
}
