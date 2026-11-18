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
  public var draft = ""
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
    !isSaving && !limitReached && AssistantInstruction.validated(draft) != nil
  }

  public func load() async {
    if instructions.isEmpty { state = .loading }
    do {
      instructions = try await api.list()
      serverSaidFull = false
      state = .loaded
    } catch {
      state = .failed(Self.instructionError(error))
    }
  }

  /// Saves the draft and clears it on success. Invalid or over-cap text never reaches the server.
  public func add() async {
    guard canAdd, let text = AssistantInstruction.validated(draft) else { return }
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }
    do {
      instructions.append(try await api.add(text: text))
      draft = ""
    } catch {
      let failure = Self.instructionError(error)
      if failure == .limitReached { serverSaidFull = true }
      errorMessage = Self.message(for: failure)
    }
  }

  /// Removes at once and puts the instruction back if the server refuses.
  public func remove(id: String) async {
    guard let index = instructions.firstIndex(where: { $0.id == id }) else { return }
    let removed = instructions.remove(at: index)
    errorMessage = nil
    do {
      try await api.remove(id: id)
      serverSaidFull = false
    } catch {
      instructions.insert(removed, at: min(index, instructions.count))
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
