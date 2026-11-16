import Foundation

/// The two answers to an agent's pending action. The raw values are the shared action identifiers the server
/// puts in the `approval_needed` push (`PENDING_ACTION_DECISIONS`) and in the route names, so the notification
/// buttons, the transcript card and the API all speak the same words.
public enum PendingActionDecision: String, Sendable, CaseIterable {
  case approve
  case deny
}

/// The pending action a decision applies to: the quest it is parked on and the `ts` the user was shown. The
/// server applies a decision to exactly that action and never to a newer one that replaced it.
public struct PendingActionTarget: Hashable, Sendable {
  public let questID: String
  /// Epoch milliseconds, as on the wire.
  public let pendingActionTs: Int64

  public init(questID: String, pendingActionTs: Int64) {
    self.questID = questID
    self.pendingActionTs = pendingActionTs
  }
}

extension PendingAction {
  /// The `ts` the server stamped on this action, rebuilt from `requestedAt` (milliseconds survive the round trip).
  public var timestampMillis: Int64 { Int64((requestedAt.timeIntervalSince1970 * 1000).rounded()) }
}

/// What a decision did. `toolSucceeded == false` means the action was approved but the tool reported a failure.
public struct PendingActionResult: Equatable, Sendable {
  public let decision: PendingActionDecision
  public let toolSucceeded: Bool
  public let message: String?

  public init(decision: PendingActionDecision, toolSucceeded: Bool = true, message: String? = nil) {
    self.decision = decision
    self.toolSucceeded = toolSucceeded
    self.message = message
  }
}

/// Why a decision did not go through. The lifecycle cases are final: acting again cannot help.
public enum PendingActionFailure: Error, Equatable, Sendable {
  /// A newer approval on the same quest replaced the one that was shown.
  case replaced
  /// The 15 minute window closed before the answer arrived.
  case expired
  /// Someone (another device, the web, a replayed notification action) already answered it.
  case alreadyResolved
  /// No such action for this user: the quest is gone, or it is not theirs.
  case notFound
  /// The notification carried no usable pending action to answer.
  case unavailable
  /// The server refused this action for a reason that will not change on retry (a tool that cannot be
  /// confirmed, a repository that is not enabled). Carries the server's own explanation.
  case refused(String)
  case api(APIError)

  /// Whether a retry could succeed (a dropped connection or a busy server), as opposed to a settled answer.
  public var isRetryable: Bool {
    guard case .api(let error) = self else { return false }
    return error.isRetryable
  }

  /// Shown as is, in the card and in the follow-up notification.
  public var message: String {
    switch self {
    case .replaced: "A newer approval replaced this one. Open the conversation to review it."
    case .expired: "This request expired before it was answered."
    case .alreadyResolved: "This request was already answered."
    case .notFound: "This request is no longer available."
    case .unavailable: "This request can't be answered from here. Open Bike4Mind to review it."
    case .refused(let reason): reason
    case .api(let error):
      switch error {
      case .offline: "You appear to be offline. Check your connection and try again."
      case .rateLimited: "Too many requests. Wait a moment and try again."
      case .server: "Bike4Mind had a problem. Try again in a moment."
      case .signedOut: "Your session ended. Sign in to Bike4Mind and try again."
      case .forbidden, .notFound: "This request is no longer available."
      case .malformedResponse, .upgradeRequired: "Update Bike4Mind to answer approvals."
      }
    }
  }
}

public protocol PendingActionAPI: Sendable {
  /// - Throws: `PendingActionFailure`.
  func respond(to target: PendingActionTarget, decision: PendingActionDecision) async throws -> PendingActionResult
}

/// Hand-written client for `POST /api/v1/pending-actions/{questId}/approve|deny` (JWT only). The body is
/// `{pendingActionTs}`; 200 is `{success, message, url?}`; 409 carries `errorCode` `action_replaced`,
/// `action_expired` or `action_already_resolved`; other 4xx refusals carry an `{error}` text; a missing,
/// malformed or foreign quest is 404. Nothing in a push authorizes the call: the server checks the session
/// owner against the access token every time.
public struct PendingActionClient: PendingActionAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func respond(
    to target: PendingActionTarget, decision: PendingActionDecision
  ) async throws
    -> PendingActionResult
  {
    guard DeepLinkRouter.isValidIdentifier(target.questID), target.pendingActionTs > 0 else {
      throw PendingActionFailure.unavailable
    }
    let body = try JSONEncoder().encode(["pendingActionTs": target.pendingActionTs])
    let response: AuthorizedRequester.Response
    do {
      response = try await requester.send(
        method: "POST", path: "api/v1/pending-actions/\(target.questID)/\(decision.rawValue)", jsonBody: body)
    } catch let error as APIError {
      throw PendingActionFailure.api(error)
    }
    return try PendingActionWire.result(status: response.status, body: response.body, decision: decision)
  }
}

enum PendingActionWire {
  private struct Success: Decodable {
    let success: Bool?
    let message: String?
  }

  private struct ErrorEnvelope: Decodable {
    let errorCode: String?
    let error: String?
  }

  /// Statuses `APIError` already gives a precise, actionable reading; every other 4xx is a settled refusal.
  private static let apiMappedClientStatuses: Set<Int> = [401, 403, 426, 429]
  private static let fallbackRefusal = "This request can't be answered from here. Open Bike4Mind to review it."

  static func result(status: Int, body: Data, decision: PendingActionDecision) throws -> PendingActionResult {
    switch status {
    case 200..<300:
      let parsed = try? JSONDecoder().decode(Success.self, from: body)
      return PendingActionResult(
        decision: decision, toolSucceeded: parsed?.success ?? true, message: parsed?.message)
    case 404:
      throw PendingActionFailure.notFound
    case 409:
      let code = (try? JSONDecoder().decode(ErrorEnvelope.self, from: body))?.errorCode
      switch code {
      case "action_replaced": throw PendingActionFailure.replaced
      case "action_expired": throw PendingActionFailure.expired
      // Also the safe reading of a bare 409 (a connector tool that is no longer offered): never retry it.
      default: throw PendingActionFailure.alreadyResolved
      }
    case 400..<500 where !apiMappedClientStatuses.contains(status):
      let reason = (try? JSONDecoder().decode(ErrorEnvelope.self, from: body))?.error?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      throw PendingActionFailure.refused(reason.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackRefusal)
    default:
      throw PendingActionFailure.api(APIError(status: status))
    }
  }
}
