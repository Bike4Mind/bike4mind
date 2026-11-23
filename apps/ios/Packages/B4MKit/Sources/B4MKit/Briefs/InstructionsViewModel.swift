import Foundation
import Observation

/// Lists, adds and removes the standing instructions the brief composer follows.
@MainActor
@Observable
public final class InstructionsViewModel {
  public enum State: Equatable, Sendable {
    case loading
    case loaded
    case failed(InstructionError)
  }

  public private(set) var state: State = .loading
  public private(set) var instructions: [AssistantInstruction] = []
  public var draft = "" {
    didSet { draftRevision &+= 1 }
  }
  private var draftRevision = 0
  private var mutationRevision = 0
  private var loadRevision = 0
  /// Adds wait for one full list so a save racing the first load cannot leave a partial list and undercount the cap.
  private var hasLoaded = false
  private var removingIds: Set<String> = []
  public private(set) var isSaving = false
  /// The last add or remove that failed, for an alert; cleared by the next attempt.
  public var errorMessage: String?
  /// The server refused an add at the cap even though the local list looked shorter (another device added one).
  private var serverSaidFull = false

  @ObservationIgnored private let api: any InstructionAPI

  public init(api: any InstructionAPI) {
    self.api = api
  }

  public var limitReached: Bool {
    serverSaidFull || instructions.count >= AssistantInstruction.maxCount
  }

  public var canAdd: Bool {
    hasLoaded && !isSaving && !limitReached && AssistantInstruction.validated(draft) != nil
  }

  public func load() async {
    // A pre-write snapshot must never replace an optimistic or committed edit.
    guard !isSaving, removingIds.isEmpty else { return }
    loadRevision &+= 1
    let requestRevision = loadRevision
    let startingMutationRevision = mutationRevision
    if instructions.isEmpty { state = .loading }
    do {
      let loaded = try await api.list()
      guard requestRevision == loadRevision, startingMutationRevision == mutationRevision else { return }
      instructions = loaded
      hasLoaded = true
      serverSaidFull = false
      state = .loaded
    } catch {
      guard requestRevision == loadRevision, startingMutationRevision == mutationRevision else { return }
      state = .failed(Self.instructionError(error))
    }
  }

  /// Saves the draft and clears it on success. Invalid or over-cap text never reaches the server.
  public func add() async {
    guard canAdd, let text = AssistantInstruction.validated(draft) else { return }
    let submittedDraftRevision = draftRevision
    isSaving = true
    mutationRevision &+= 1
    errorMessage = nil
    defer {
      isSaving = false
      mutationRevision &+= 1
    }
    do {
      instructions.append(try await api.add(text: text))
      state = .loaded
      if draftRevision == submittedDraftRevision { draft = "" }
    } catch {
      let failure = Self.instructionError(error)
      if failure == .limitReached { serverSaidFull = true }
      if state == .loading, instructions.isEmpty { state = .failed(failure) }
      errorMessage = Self.message(for: failure)
    }
  }

  /// Removes at once and puts the instruction back if the server refuses.
  public func remove(id: String) async {
    guard let index = instructions.firstIndex(where: { $0.id == id }) else { return }
    let removed = instructions.remove(at: index)
    removingIds.insert(id)
    mutationRevision &+= 1
    defer {
      removingIds.remove(id)
      mutationRevision &+= 1
    }
    errorMessage = nil
    do {
      try await api.remove(id: id)
      serverSaidFull = false
    } catch {
      if !instructions.contains(where: { $0.id == removed.id }) {
        instructions.insert(removed, at: min(index, instructions.count))
      }
      errorMessage = Self.message(for: Self.instructionError(error))
    }
  }

  private static func instructionError(_ error: any Error) -> InstructionError {
    switch error {
    case let error as InstructionError: error
    case let error as APIError: .api(error)
    default: .api(.malformedResponse)
    }
  }

  static func message(for error: InstructionError) -> String {
    switch error {
    case .limitReached:
      "You can keep up to \(AssistantInstruction.maxCount) instructions. Remove one to add another."
    case .invalidText:
      "Instructions need some text and can be up to \(AssistantInstruction.maxLength) characters."
    case .api(.offline):
      "You're offline. Try again when you're connected."
    case .api:
      "That didn't go through. Try again."
    }
  }
}
