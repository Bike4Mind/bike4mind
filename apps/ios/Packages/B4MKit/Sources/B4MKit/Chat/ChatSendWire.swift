import Foundation

/// Hand-written wire format for `POST /api/chat` (operationId `sendChatMessage`, contract
/// b4m-core/common/src/api-contract/contracts/chat.contract.ts).
///
/// Why hand-written: the request schema declares both `max_tokens` and `maxTokens`, which collide under
/// the generator's idiomatic naming, and the 200 body is a two-branch `anyOf` that would pull a large
/// generated type graph into the app for the five fields it reads. The app sends only the fields below
/// and reads only the queued-receipt fields, so a focused pair is smaller and easier to keep honest than
/// a generator workaround. Keep it in sync with the contract when either side changes.
enum ChatSendWire {
  struct Body: Encodable, Equatable {
    let message: String
    let sessionId: String?
    let newConversation: Bool?
    /// Lets capable models stream tokens; the reply reaches the app over the socket either way.
    let stream: Bool
    /// Omitted (not `[]`) when nothing is attached, so a plain message's body is unchanged.
    let fileIds: [String]?
  }

  static func body(for request: ChatSendRequest) throws -> Data {
    let body: Body
    let fileIds = request.fileIDs.isEmpty ? nil : request.fileIDs
    switch request.target {
    case .session(let id):
      body = Body(message: request.message, sessionId: id, newConversation: nil, stream: true, fileIds: fileIds)
    case .newConversation:
      body = Body(message: request.message, sessionId: nil, newConversation: true, stream: true, fileIds: fileIds)
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try encoder.encode(body)
  }

  private struct Receipt: Decodable {
    struct TrackingInfo: Decodable {
      let questID: String?

      enum CodingKeys: String, CodingKey {
        case questID = "quest_id"
      }
    }

    let id: String?
    let sessionId: String?
    let type: String?
    let errorCode: String?
    let message: String?
    let trackingInfo: TrackingInfo?

    enum CodingKeys: String, CodingKey {
      case id, sessionId, type, errorCode, message
      case trackingInfo = "tracking_info"
    }
  }

  static func receipt(status: Int, body: Data) throws -> ChatSendReceipt {
    guard status == 200 else { throw APIError(status: status) }
    guard let receipt = try? JSONDecoder().decode(Receipt.self, from: body),
      let questID = receipt.id ?? receipt.trackingInfo?.questID
    else { throw APIError.malformedResponse }
    return ChatSendReceipt(
      questID: questID,
      sessionID: receipt.sessionId,
      kind: receipt.type.flatMap(QuestTurn.Kind.init(rawValue:)),
      errorCode: receipt.errorCode.flatMap(QuestTurn.ErrorCode.init(rawValue:)),
      message: receipt.message)
  }
}
