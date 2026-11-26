import Foundation

/// Follow-up memos: a dictated transcript becomes a brief of proposed action items, a draft email and
/// reminders, each edited, approved or dismissed here. The server executes none of them.
public protocol BriefFollowUpAPI: Sendable {
  /// Starts composing a follow-up brief from a transcript. The returned brief is usually still `.composing`.
  func followUp(transcript: String, timeZone: String?) async throws -> Brief
  /// - Throws: `BriefDecisionFailure`.
  func editDecision(briefID: String, decisionID: String, edit: BriefDecisionEdit) async throws -> BriefDecision
  /// - Throws: `BriefDecisionFailure`.
  func resolveDecision(
    briefID: String, decisionID: String, outcome: BriefDecisionOutcome
  ) async throws
    -> BriefDecision
}

/// The fields of a pending follow-up to replace. `draftReply` applies to an email, `remindAt` to a reminder.
public struct BriefDecisionEdit: Equatable, Sendable, Encodable {
  public var text: String?
  public var draftReply: BriefDraftReply?
  public var remindAt: Date?

  public init(text: String? = nil, draftReply: BriefDraftReply? = nil, remindAt: Date? = nil) {
    self.text = text
    self.draftReply = draftReply
    self.remindAt = remindAt
  }

  public var isEmpty: Bool { text == nil && draftReply == nil && remindAt == nil }

  /// The fields an edit form changed against `decision`. The form sends trimmed values, so the server draft is
  /// compared trimmed too, or an untouched email reads as edited. Twin of the Android kit `followUpEdit`.
  public init(
    changing decision: BriefDecision, kind: BriefFollowUpKind?, text: String, draft: BriefDraftReply,
    remindAt: Date, initialRemindAt: Date
  ) {
    self.init()
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedText != decision.text { self.text = trimmedText }
    if kind == .followUpEmail {
      // An email without a draft yet compares as blank fields, so untouched ones do not block a text-only save.
      let current = (decision.draftReply ?? BriefDraftReply(to: "", subject: "", body: "")).trimmed
      if draft.trimmed != current { self.draftReply = draft.trimmed }
    }
    if kind == .reminder, remindAt != initialRemindAt { self.remindAt = remindAt }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(text, forKey: .text)
    try container.encodeIfPresent(draftReply, forKey: .draftReply)
    try container.encodeIfPresent(remindAt.map { $0.formatted(.iso8601) }, forKey: .remindAt)
  }

  private enum CodingKeys: String, CodingKey {
    case text, draftReply, remindAt
  }
}

public enum BriefDecisionOutcome: String, Equatable, Sendable, Encodable {
  case approve
  case dismiss
}

/// Why an edit, approve or dismiss did not go through. `.closed` is final: the follow-up was already settled.
public enum BriefDecisionFailure: Error, Equatable, Sendable {
  case closed
  case notFound
  /// The server rejected the change, e.g. approving an email whose recipient is not an address yet.
  case invalid(String)
  case api(APIError)

  public var message: String {
    switch self {
    case .closed: "This follow-up was already settled."
    case .notFound: "This follow-up is no longer available."
    case .invalid(let reason): reason
    case .api(.offline): "You appear to be offline. Check your connection and try again."
    case .api(.rateLimited): "Too many requests. Wait a moment and try again."
    case .api(.signedOut): "Your session ended. Sign in to Bike4Mind and try again."
    case .api: "Bike4Mind had a problem saving that. Try again in a moment."
    }
  }
}

extension BriefClient: BriefFollowUpAPI {
  // Must match BRIEF_DECISION_CLOSED_ERROR_CODE in b4m-core/common/src/apiErrorCodes.ts.
  static let decisionClosedErrorCode = "decision_closed"
  static let fallbackInvalidDecision = "That change could not be saved. Check the follow-up and try again."

  public func followUp(transcript: String, timeZone: String?) async throws -> Brief {
    struct Body: Encodable {
      let transcript: String
      let timeZone: String?
    }
    let body = try JSONEncoder().encode(Body(transcript: transcript, timeZone: timeZone))
    let response = try await requester.send(method: "POST", path: "api/v1/briefs/follow-ups", jsonBody: body)
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
    guard let brief = try? Self.decoder.decode(Brief.self, from: response.body) else {
      throw APIError.malformedResponse
    }
    return brief
  }

  public func editDecision(briefID: String, decisionID: String, edit: BriefDecisionEdit) async throws -> BriefDecision {
    try await sendDecision(method: "PATCH", briefID: briefID, decisionID: decisionID, suffix: "", body: edit)
  }

  public func resolveDecision(
    briefID: String, decisionID: String, outcome: BriefDecisionOutcome
  ) async throws -> BriefDecision {
    struct Body: Encodable { let outcome: BriefDecisionOutcome }
    return try await sendDecision(
      method: "POST", briefID: briefID, decisionID: decisionID, suffix: "/resolve", body: Body(outcome: outcome))
  }

  private func sendDecision(
    method: String, briefID: String, decisionID: String, suffix: String, body: some Encodable
  ) async throws -> BriefDecision {
    guard DeepLinkRouter.isValidIdentifier(briefID), DeepLinkRouter.isValidIdentifier(decisionID) else {
      throw BriefDecisionFailure.notFound
    }
    let json = try JSONEncoder().encode(body)
    let response: AuthorizedRequester.Response
    do {
      response = try await requester.send(
        method: method, path: "api/v1/briefs/\(briefID)/decisions/\(decisionID)\(suffix)", jsonBody: json)
    } catch let error as APIError {
      throw BriefDecisionFailure.api(error)
    }
    switch response.status {
    case 200..<300:
      guard let decision = try? Self.decoder.decode(BriefDecision.self, from: response.body) else {
        throw BriefDecisionFailure.api(.malformedResponse)
      }
      return decision
    case 404: throw BriefDecisionFailure.notFound
    case 409 where Self.errorEnvelope(response.body)?.errorCode == Self.decisionClosedErrorCode:
      throw BriefDecisionFailure.closed
    case 400:
      let reason = Self.errorEnvelope(response.body)?.error?.trimmingCharacters(in: .whitespacesAndNewlines)
      throw BriefDecisionFailure.invalid(reason.flatMap { $0.isEmpty ? nil : $0 } ?? Self.fallbackInvalidDecision)
    default: throw BriefDecisionFailure.api(APIError(status: response.status))
    }
  }
}

extension BriefDraftReply {
  fileprivate var trimmed: BriefDraftReply {
    BriefDraftReply(
      to: to.trimmingCharacters(in: .whitespacesAndNewlines),
      subject: subject.trimmingCharacters(in: .whitespacesAndNewlines),
      body: body.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}
