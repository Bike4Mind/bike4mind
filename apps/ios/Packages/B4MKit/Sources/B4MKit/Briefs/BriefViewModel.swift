import Foundation
import Observation

/// Loads and composes the brief screen's content. With an id (a push tap) it shows that brief; without one
/// (the drawer row) it shows the latest. A brief still composing is polled until it settles.
@MainActor
@Observable
public final class BriefViewModel {
  public enum State: Equatable, Sendable {
    case loading
    case loaded
    case failed(APIError)
  }

  /// A reply sent from this screen. `.closed` never lands here: the refetch shows the question's own state.
  public enum ReplyState: Equatable, Sendable {
    case submitting
    case sent
    case failed(BriefReplyFailure)
  }

  /// An edit, approve or dismiss of a follow-up sent from this screen. A success swaps in the returned decision.
  public enum FollowUpState: Equatable, Sendable {
    case submitting
    case failed(BriefDecisionFailure)
  }

  public typealias Sleep = @Sendable (Duration) async throws -> Void

  public private(set) var state: State = .loading
  /// The brief on screen; `nil` after a load that found none (the empty state).
  public private(set) var brief: Brief? {
    didSet {
      guard oldValue?.id != brief?.id else { return }
      approvalStates = [:]
      replyStates = [:]
      replyDrafts = [:]
      followUpStates = [:]
    }
  }
  /// Whether a compose request or a poll of a composing brief is in flight.
  public private(set) var isComposing = false
  /// The poll gave up waiting. The brief may still finish: refreshing looks again.
  public private(set) var composeTimedOut = false
  /// Approvals answered from this screen, by decision id. The brief's live `state` stays authoritative once
  /// it leaves `.pending`; this covers the request in flight and failures a refetch cannot show.
  public private(set) var approvalStates: [String: ApprovalCardState] = [:]
  public private(set) var replyStates: [String: ReplyState] = [:]
  /// Drafts belong to the displayed brief, just like its local decision states.
  public private(set) var replyDrafts: [String: String] = [:]
  public private(set) var followUpStates: [String: FollowUpState] = [:]

  public func setReplyDraft(_ text: String, decisionID: String, briefID: String?) {
    guard let briefID, brief?.id == briefID else { return }
    replyDrafts[decisionID] = text
  }

  @ObservationIgnored private let api: any BriefAPI
  @ObservationIgnored private let pendingActions: (any PendingActionAPI)?
  @ObservationIgnored private let followUps: (any BriefFollowUpAPI)?
  @ObservationIgnored private let briefID: String?
  @ObservationIgnored private let sleep: Sleep
  @ObservationIgnored private let pollInterval: Duration
  @ObservationIgnored private let maxPolls: Int
  @ObservationIgnored private var composeTask: Task<Void, Never>?
  /// One poll at a time: a second loop would clear `isComposing` out from under the first.
  @ObservationIgnored private var isPolling = false

  public init(
    api: any BriefAPI, briefID: String? = nil, pendingActions: (any PendingActionAPI)? = nil,
    followUps: (any BriefFollowUpAPI)? = nil,
    pollInterval: Duration = .seconds(8),
    pollWindow: Duration = .seconds(120),
    sleep: @escaping Sleep = { try await Task.sleep(for: $0) }
  ) {
    self.api = api
    self.briefID = briefID
    self.pendingActions = pendingActions
    self.followUps = followUps
    self.pollInterval = pollInterval
    self.sleep = sleep
    maxPolls = max(1, Int(pollWindow / pollInterval))
  }

  /// First load. Does not clear what is on screen if it fails after a brief arrived.
  public func load() async {
    if brief == nil { state = .loading }
    await fetch()
    await pollWhileComposing()
  }

  public func refresh() async {
    composeTimedOut = false
    await fetch()
    await pollWhileComposing()
  }

  /// Asks the server to compose a fresh brief, then polls until it is ready or failed.
  public func composeNow() async {
    guard !isComposing else { return }
    isComposing = true
    composeTimedOut = false
    do {
      brief = try await api.compose()
      state = .loaded
    } catch {
      isComposing = false
      state = .failed(Self.apiError(from: error))
      return
    }
    await pollWhileComposing()
  }

  /// `composeNow()` as a task the view can cancel when it disappears.
  public func startCompose() {
    composeTask?.cancel()
    composeTask = Task { await composeNow() }
  }

  public func cancel() {
    composeTask?.cancel()
    composeTask = nil
  }

  /// Approves or denies a decision's approval, then re-fetches the brief. A replaced, lapsed or already
  /// answered approval is not an error here: the refetched live state shows what became of it.
  public func decide(_ decision: BriefDecision, _ answer: PendingActionDecision) async {
    let local = approvalStates[decision.id]
    guard let brief, brief.decisions.contains(decision), let pendingActions,
      let approval = decision.approval, approval.state == .pending,
      answer == .deny ? local?.offersDeny ?? true : local?.offersDecision ?? true
    else { return }
    approvalStates[decision.id] = .submitting(answer)
    do {
      let result = try await pendingActions.respond(to: approval.target, decision: answer)
      guard self.brief?.id == brief.id else { return }
      approvalStates[decision.id] = .answered(result)
    } catch let failure as PendingActionFailure {
      guard self.brief?.id == brief.id else { return }
      switch failure {
      case .replaced, .expired, .alreadyResolved: approvalStates[decision.id] = nil
      default: approvalStates[decision.id] = .failed(failure)
      }
    } catch {
      guard self.brief?.id == brief.id else { return }
      approvalStates[decision.id] = .failed(.api(Self.apiError(from: error)))
    }
    await reload(briefID: brief.id)
  }

  /// Replies to a question decision, then re-fetches the brief so its live state shows the outcome.
  public func reply(_ decision: BriefDecision, text: String, choiceIndex: Int? = nil) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let brief, brief.decisions.contains(decision), decision.question?.state == .open, !trimmed.isEmpty else {
      return
    }
    switch replyStates[decision.id] {
    case .submitting, .sent: return
    case .failed, nil: break
    }
    replyStates[decision.id] = .submitting
    do {
      _ = try await api.reply(briefID: brief.id, decisionID: decision.id, text: trimmed, choiceIndex: choiceIndex)
      guard self.brief?.id == brief.id else { return }
      replyStates[decision.id] = .sent
      if replyDrafts[decision.id]?.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed {
        replyDrafts[decision.id] = nil
      }
    } catch BriefReplyFailure.closed {
      guard self.brief?.id == brief.id else { return }
      replyStates[decision.id] = nil
    } catch let failure as BriefReplyFailure {
      guard self.brief?.id == brief.id else { return }
      replyStates[decision.id] = .failed(failure)
    } catch {
      guard self.brief?.id == brief.id else { return }
      replyStates[decision.id] = .failed(.api(Self.apiError(from: error)))
    }
    await reload(briefID: brief.id)
  }

  /// Saves an edit to a pending follow-up. Returns whether the edit form is done: saved, or the follow-up settled
  /// elsewhere and can no longer be edited. When it is not, the form stays open with the user's changes.
  @discardableResult
  public func editFollowUp(_ decision: BriefDecision, _ edit: BriefDecisionEdit) async -> Bool {
    guard !edit.isEmpty else { return false }
    let saved =
      await submitFollowUp(decision) { api, briefID in
        try await api.editDecision(briefID: briefID, decisionID: decision.id, edit: edit)
      } != nil
    return saved || brief?.decisions.first(where: { $0.id == decision.id })?.followUp?.isActionable != true
  }

  /// Approves or dismisses a pending follow-up. Returns the draft of an approved follow-up email so the caller can
  /// hand it to the device mail app; the server never sends it.
  @discardableResult
  public func resolveFollowUp(_ decision: BriefDecision, _ outcome: BriefDecisionOutcome) async -> BriefDraftReply? {
    let resolved = await submitFollowUp(decision) { api, briefID in
      try await api.resolveDecision(briefID: briefID, decisionID: decision.id, outcome: outcome)
    }
    guard outcome == .approve, let resolved, resolved.followUp?.kind == .followUpEmail else { return nil }
    return resolved.draftReply
  }

  public func followUpFailure(for decision: BriefDecision) -> BriefDecisionFailure? {
    guard case .failed(let failure) = followUpStates[decision.id] else { return nil }
    return failure
  }

  private func submitFollowUp(
    _ decision: BriefDecision,
    _ call: @Sendable (any BriefFollowUpAPI, String) async throws -> BriefDecision
  ) async -> BriefDecision? {
    guard let brief, let followUps, let current = brief.decisions.first(where: { $0.id == decision.id }),
      current.followUp?.isActionable == true, followUpStates[decision.id] != .submitting
    else { return nil }
    followUpStates[decision.id] = .submitting
    do {
      let updated = try await call(followUps, brief.id)
      guard let shown = self.brief, shown.id == brief.id else { return nil }
      followUpStates[decision.id] = nil
      self.brief = shown.replacing(updated)
      return updated
    } catch BriefDecisionFailure.closed {
      guard self.brief?.id == brief.id else { return nil }
      followUpStates[decision.id] = nil
      await reload(briefID: brief.id)
    } catch let failure as BriefDecisionFailure {
      guard self.brief?.id == brief.id else { return nil }
      followUpStates[decision.id] = .failed(failure)
    } catch {
      guard self.brief?.id == brief.id else { return nil }
      followUpStates[decision.id] = .failed(.api(Self.apiError(from: error)))
    }
    return nil
  }

  /// Keep dispatch feedback visible even when a refresh closes the question.
  public func replyFailure(for decision: BriefDecision) -> BriefReplyFailure? {
    guard let question = decision.question, case .failed(let failure) = replyStates[decision.id] else { return nil }
    if case .dispatchFailed = failure { return failure }
    return question.state == .open ? failure : nil
  }

  /// Re-reads the brief on screen by id, so a drawer-opened brief does not jump to a newer one.
  private func reload(briefID: String) async {
    guard brief?.id == briefID else { return }
    do {
      let updated = try await api.brief(id: briefID)
      guard brief?.id == briefID else { return }
      brief = updated
      state = .loaded
    } catch is CancellationError {
      return
    } catch {
      guard brief?.id == briefID else { return }
      state = .failed(Self.apiError(from: error))
    }
  }

  private func fetch() async {
    do {
      if let briefID {
        brief = try await api.brief(id: briefID)
      } else {
        let briefs = try await api.list()
        // The newest ready brief wins over a newer one still composing or failed, so a re-open shows content.
        brief = briefs.first { $0.status == .ready } ?? briefs.first
      }
      state = .loaded
    } catch is CancellationError {
      return
    } catch {
      state = .failed(Self.apiError(from: error))
    }
  }

  private func pollWhileComposing() async {
    guard !isPolling else { return }
    guard brief?.status == .composing, case .loaded = state else {
      isComposing = false
      return
    }
    isPolling = true
    isComposing = true
    composeTimedOut = false
    defer {
      isPolling = false
      isComposing = false
    }
    for _ in 0..<maxPolls {
      do {
        try await sleep(pollInterval)
        guard let current = brief else { return }
        brief = try await api.brief(id: current.id)
      } catch is CancellationError {
        return
      } catch APIError.rateLimited {
        // The per-minute limit counts every poll; the window resets, so wait and look again.
        continue
      } catch {
        state = .failed(Self.apiError(from: error))
        return
      }
      if brief?.status != .composing { return }
    }
    composeTimedOut = true
  }

  private static func apiError(from error: any Error) -> APIError {
    error as? APIError ?? .malformedResponse
  }
}
