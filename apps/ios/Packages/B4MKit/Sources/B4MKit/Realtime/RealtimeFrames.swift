import Foundation

/// A document change pushed for a `subscribe_query` subscription. The initial fetch (up to 200
/// documents) arrives as a burst of these too.
public struct DataUpdate: Hashable, Sendable {
  public let subscriptionID: String
  public let collectionName: String
  /// Mongo change-stream operation (`insert`, `update`, `replace`, `delete`, ...); open set.
  public let operationType: String
  /// The document, carrying at least `_id`/`id`; fields follow the subscription's projection.
  public let data: JSONObject

  public init(subscriptionID: String, collectionName: String, operationType: String, data: JSONObject) {
    self.subscriptionID = subscriptionID
    self.collectionName = collectionName
    self.operationType = operationType
    self.data = data
  }

  public var documentID: String? { data["id"]?.stringValue ?? data["_id"]?.stringValue }
}

/// Any server frame routed by its `action`, other than the protocol frames `WSClient` consumes itself
/// (`data_update`, `data_subscribe_error`, `resubscribe_required`). Chat streaming
/// (`streamed_chat_completion`) and agent-run frames reach consumers through this.
public struct ActionFrame: Hashable, Sendable {
  public let action: String
  public let payload: JSONObject

  public init(action: String, payload: JSONObject) {
    self.action = action
    self.payload = payload
  }
}

/// One piece of a frame the server split because it exceeded the gateway's frame size.
/// `data` is a plain substring of the original JSON text.
struct FrameChunk: Equatable, Sendable {
  let chunkID: String
  let index: Int
  let total: Int
  let data: String
}

/// What one received text frame means. Parsing never throws: the server may send bare text
/// (`pong`), empty frames, or actions this build does not know, and none of those may break the
/// connection.
enum InboundFrame: Equatable, Sendable {
  case pong
  case chunk(FrameChunk)
  case dataUpdate(DataUpdate)
  case subscribeError(subscriptionID: String, message: String)
  case resubscribeRequired
  case action(ActionFrame)
  /// Empty, non-JSON, non-object, or missing the routing field.
  case ignored

  static func parse(_ text: String) -> InboundFrame {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return .ignored }
    // The heartbeat Lambda answers with the bare text `pong`, not JSON.
    if trimmed == "pong" { return .pong }
    guard let object = JSONValue.parse(trimmed)?.objectValue else { return .ignored }
    return parse(object)
  }

  static func parse(_ object: JSONObject) -> InboundFrame {
    // Chunk frames carry no `action`, so they must be recognized before routing.
    if object["_chunked"]?.boolValue == true {
      guard let chunkID = object["_chunkId"]?.stringValue, !chunkID.isEmpty,
        let index = object["_chunkIndex"]?.numberValue,
        let total = object["_totalChunks"]?.numberValue,
        let data = object["_data"]?.stringValue,
        index >= 0, total >= 1, index < total,
        index.rounded() == index, total.rounded() == total
      else { return .ignored }
      return .chunk(FrameChunk(chunkID: chunkID, index: Int(index), total: Int(total), data: data))
    }

    guard let action = object["action"]?.stringValue else { return .ignored }
    switch action {
    case "pong":
      return .pong
    case "resubscribe_required":
      return .resubscribeRequired
    case "data_update":
      guard let subscriptionID = object["subscriptionId"]?.stringValue,
        let data = object["data"]?.objectValue
      else { return .ignored }
      return .dataUpdate(
        DataUpdate(
          subscriptionID: subscriptionID,
          collectionName: object["collectionName"]?.stringValue ?? "",
          operationType: object["operationType"]?.stringValue ?? "",
          data: data))
    case "data_subscribe_error":
      guard let subscriptionID = object["subscriptionId"]?.stringValue else { return .ignored }
      return .subscribeError(subscriptionID: subscriptionID, message: object["error"]?.stringValue ?? "")
    default:
      return .action(ActionFrame(action: action, payload: object))
    }
  }
}

/// Client-to-server frames. Field names mirror the server's action schemas
/// (b4m-core/common/src/schemas/actions.ts); keep them in sync.
enum OutboundFrame: Equatable, Sendable {
  case heartbeat
  case reauthenticate(accessToken: String)
  case subscribe(SubscriptionRequest)
  case unsubscribe(subscriptionID: String)

  var json: JSONValue {
    switch self {
    case .heartbeat:
      ["action": "heartbeat"]
    case .reauthenticate(let token):
      ["action": "reauth_connection", "accessToken": .string(token)]
    case .subscribe(let request):
      [
        "action": "subscribe_query",
        "subscriptionId": .string(request.subscriptionID),
        "collectionName": .string(request.collectionName),
        "query": .object(request.query),
        "fields": .object(request.fields),
        "fetchInitialData": .bool(request.fetchInitialData),
      ]
    case .unsubscribe(let id):
      ["action": "unsubscribe_query", "subscriptionId": .string(id)]
    }
  }

  var text: String { json.encodedString() }
}

/// A live query: the server pushes every change to documents in `collectionName` matching `query`,
/// projected to `fields`.
public struct SubscriptionRequest: Hashable, Sendable {
  public let subscriptionID: String
  public let collectionName: String
  /// Mongo filter; the server enforces an operator allow-list.
  public let query: JSONObject
  /// Projection flags (`["reply": true]`).
  public let fields: JSONObject
  public let fetchInitialData: Bool

  public init(
    subscriptionID: String = UUID().uuidString, collectionName: String, query: JSONObject, fields: JSONObject,
    fetchInitialData: Bool
  ) {
    self.subscriptionID = subscriptionID
    self.collectionName = collectionName
    self.query = query
    self.fields = fields
    self.fetchInitialData = fetchInitialData
  }
}
