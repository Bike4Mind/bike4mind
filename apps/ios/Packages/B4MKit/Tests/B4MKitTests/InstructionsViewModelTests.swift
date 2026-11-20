import XCTest

@testable import B4MKit

private actor FakeInstructionAPI: InstructionAPI {
  var listResult: Result<[AssistantInstruction], InstructionError> = .success([])
  var addError: InstructionError?
  var removeError: InstructionError?
  private(set) var added: [String] = []
  private(set) var removed: [String] = []

  func set(
    list: Result<[AssistantInstruction], InstructionError>? = nil, addError: InstructionError? = nil,
    removeError: InstructionError? = nil
  ) {
    if let list { listResult = list }
    self.addError = addError
    self.removeError = removeError
  }

  func list() async throws -> [AssistantInstruction] { try listResult.get() }

  func add(text: String) async throws -> AssistantInstruction {
    if let addError { throw addError }
    added.append(text)
    return makeInstruction(id: "new-\(added.count)", text: text)
  }

  func remove(id: String) async throws {
    if let removeError { throw removeError }
    removed.append(id)
  }
}

private func makeInstruction(id: String, text: String = "Lead with invoices") -> AssistantInstruction {
  AssistantInstruction(id: id, text: text, createdAt: Date())
}

@MainActor
final class InstructionsViewModelTests: XCTestCase {
  func testLoadShowsTheList() async {
    let api = FakeInstructionAPI()
    await api.set(list: .success([makeInstruction(id: "a"), makeInstruction(id: "b")]))
    let model = InstructionsViewModel(api: api)
    await model.load()
    XCTAssertEqual(model.state, .loaded)
    XCTAssertEqual(model.instructions.map(\.id), ["a", "b"])
  }

  func testAddTrimsAndClearsTheDraft() async {
    let api = FakeInstructionAPI()
    let model = InstructionsViewModel(api: api)
    await model.load()
    model.draft = "  Lead with invoices \n"
    await model.add()
    let added = await api.added
    XCTAssertEqual(added, ["Lead with invoices"])
    XCTAssertEqual(model.instructions.map(\.text), ["Lead with invoices"])
    XCTAssertEqual(model.draft, "")
  }

  func testInvalidDraftsNeverReachTheServer() async {
    let api = FakeInstructionAPI()
    let model = InstructionsViewModel(api: api)
    await model.load()
    for draft in ["", "   \n ", String(repeating: "x", count: 281)] {
      model.draft = draft
      XCTAssertFalse(model.canAdd)
      await model.add()
    }
    model.draft = String(repeating: "x", count: 280)
    XCTAssertTrue(model.canAdd)
    let added = await api.added
    XCTAssertTrue(added.isEmpty)
  }

  func testAddIsBlockedAtTheCap() async {
    let api = FakeInstructionAPI()
    let full = (0..<AssistantInstruction.maxCount).map { makeInstruction(id: "i\($0)") }
    await api.set(list: .success(full))
    let model = InstructionsViewModel(api: api)
    await model.load()
    model.draft = "One more"
    XCTAssertTrue(model.limitReached)
    XCTAssertFalse(model.canAdd)
    await model.add()
    let added = await api.added
    XCTAssertTrue(added.isEmpty)
  }

  func testServerLimitRefusalSetsTheFlagUntilARemove() async {
    let api = FakeInstructionAPI()
    await api.set(list: .success([makeInstruction(id: "a")]), addError: .limitReached)
    let model = InstructionsViewModel(api: api)
    await model.load()
    model.draft = "One more"
    await model.add()
    XCTAssertTrue(model.limitReached)
    XCTAssertNotNil(model.errorMessage)
    XCTAssertEqual(model.draft, "One more")

    await model.remove(id: "a")
    XCTAssertFalse(model.limitReached)
  }

  func testRemoveRollsBackWhenTheServerRefuses() async {
    let api = FakeInstructionAPI()
    await api.set(
      list: .success([makeInstruction(id: "a"), makeInstruction(id: "b"), makeInstruction(id: "c")]),
      removeError: .api(.offline))
    let model = InstructionsViewModel(api: api)
    await model.load()
    await model.remove(id: "b")
    XCTAssertEqual(model.instructions.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(model.errorMessage, InstructionsViewModel.message(for: .api(.offline)))
  }

  func testRemoveDropsTheRowOnSuccess() async {
    let api = FakeInstructionAPI()
    await api.set(list: .success([makeInstruction(id: "a"), makeInstruction(id: "b")]))
    let model = InstructionsViewModel(api: api)
    await model.load()
    await model.remove(id: "a")
    let removed = await api.removed
    XCTAssertEqual(removed, ["a"])
    XCTAssertEqual(model.instructions.map(\.id), ["b"])
    XCTAssertNil(model.errorMessage)
  }

  func testLoadFailureIsShown() async {
    let api = FakeInstructionAPI()
    await api.set(list: .failure(.api(.offline)))
    let model = InstructionsViewModel(api: api)
    await model.load()
    XCTAssertEqual(model.state, .failed(.api(.offline)))
  }
}

private actor SuspendedInstructionAPI: InstructionAPI {
  enum Call: Hashable { case list(Int), add, remove }
  private var listCount = 0
  private var lists: [Int: CheckedContinuation<[AssistantInstruction], any Error>] = [:]
  private var addition: CheckedContinuation<AssistantInstruction, any Error>?
  private var removal: CheckedContinuation<Void, any Error>?
  private var started: Set<Call> = []
  private var observers: [Call: [CheckedContinuation<Void, Never>]] = [:]
  private(set) var added: [String] = []

  func waitFor(_ call: Call) async {
    if started.contains(call) { return }
    await withCheckedContinuation { observers[call, default: []].append($0) }
  }

  private func markStarted(_ call: Call) {
    started.insert(call)
    observers.removeValue(forKey: call)?.forEach { $0.resume() }
  }

  func list() async throws -> [AssistantInstruction] {
    listCount += 1
    let call = listCount
    return try await withCheckedThrowingContinuation {
      lists[call] = $0
      markStarted(.list(call))
    }
  }

  func add(text: String) async throws -> AssistantInstruction {
    added.append(text)
    return try await withCheckedThrowingContinuation {
      addition = $0
      markStarted(.add)
    }
  }

  func remove(id: String) async throws {
    try await withCheckedThrowingContinuation {
      removal = $0
      markStarted(.remove)
    }
  }

  func finishList(_ call: Int, _ result: Result<[AssistantInstruction], InstructionError>) {
    guard let continuation = lists.removeValue(forKey: call) else { preconditionFailure("No held list") }
    continuation.resume(with: result.mapError { $0 as any Error })
  }

  func finishAdd(_ instruction: AssistantInstruction) {
    guard let continuation = addition else { preconditionFailure("No held add") }
    addition = nil
    continuation.resume(returning: instruction)
  }

  func failAdd(_ error: InstructionError) {
    guard let continuation = addition else { preconditionFailure("No held add") }
    addition = nil
    continuation.resume(throwing: error)
  }

  func finishRemove(_ result: Result<Void, InstructionError>) {
    guard let continuation = removal else { preconditionFailure("No held remove") }
    removal = nil
    continuation.resume(with: result.mapError { $0 as any Error })
  }
}

@MainActor
extension InstructionsViewModelTests {
  private func prime(
    _ model: InstructionsViewModel, _ api: SuspendedInstructionAPI, _ rows: [AssistantInstruction]
  ) async {
    let loading = Task { await model.load() }
    await api.waitFor(.list(1))
    await api.finishList(1, .success(rows))
    await loading.value
  }

  func testSavingKeepsANewDraftAndDoesNotSubmitTwice() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    await prime(model, api, [])
    model.draft = "Submitted"
    let saving = Task { await model.add() }
    await api.waitFor(.add)
    model.draft = "Next draft"
    await model.add()
    await api.finishAdd(makeInstruction(id: "saved", text: "Submitted"))
    await saving.value
    XCTAssertEqual(model.draft, "Next draft")
    XCTAssertEqual(model.instructions.map(\.id), ["saved"])
    let added = await api.added
    XCTAssertEqual(added, ["Submitted"])
  }

  func testSavingKeepsADraftEditedAwayAndBackToTheSubmittedText() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    await prime(model, api, [])
    model.draft = "Submitted"
    let saving = Task { await model.add() }
    await api.waitFor(.add)
    model.draft = "Another draft"
    model.draft = "Submitted"
    await api.finishAdd(makeInstruction(id: "saved"))
    await saving.value
    XCTAssertEqual(model.draft, "Submitted")
  }

  func testARefreshStartedBeforeAnAddCannotEraseTheSavedInstruction() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    await prime(model, api, [])
    let refresh = Task { await model.load() }
    await api.waitFor(.list(2))
    model.draft = "New instruction"
    let saving = Task { await model.add() }
    await api.waitFor(.add)
    await api.finishAdd(makeInstruction(id: "saved"))
    await saving.value
    await api.finishList(2, .success([]))
    await refresh.value
    XCTAssertEqual(model.instructions.map(\.id), ["saved"])
    XCTAssertEqual(model.state, .loaded)
  }

  func testARefreshStartedBeforeARemoveCannotResurrectTheDeletedInstruction() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    let row = makeInstruction(id: "a")
    await prime(model, api, [row])
    let refresh = Task { await model.load() }
    await api.waitFor(.list(2))
    let deleting = Task { await model.remove(id: "a") }
    await api.waitFor(.remove)
    await api.finishRemove(.success(()))
    await deleting.value
    await api.finishList(2, .success([row]))
    await refresh.value
    XCTAssertTrue(model.instructions.isEmpty)
  }

  func testARefreshDuringAFailedRemoveCannotDuplicateTheRollback() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    let rows = [makeInstruction(id: "a"), makeInstruction(id: "b")]
    await prime(model, api, rows)
    let refresh = Task { await model.load() }
    await api.waitFor(.list(2))
    let deleting = Task { await model.remove(id: "a") }
    await api.waitFor(.remove)
    await api.finishList(2, .success(rows))
    await refresh.value
    await api.finishRemove(.failure(.api(.offline)))
    await deleting.value
    XCTAssertEqual(model.instructions.map(\.id), ["a", "b"])
    XCTAssertEqual(model.errorMessage, InstructionsViewModel.message(for: .api(.offline)))
  }

  func testOnlyTheNewestRefreshMayApply() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    let older = Task { await model.load() }
    await api.waitFor(.list(1))
    let newer = Task { await model.load() }
    await api.waitFor(.list(2))
    await api.finishList(2, .success([makeInstruction(id: "new")]))
    await newer.value
    await api.finishList(1, .failure(.api(.offline)))
    await older.value
    XCTAssertEqual(model.instructions.map(\.id), ["new"])
    XCTAssertEqual(model.state, .loaded)
  }

  func testAddWaitsForTheInitialLoad() async {
    let api = SuspendedInstructionAPI()
    let model = InstructionsViewModel(api: api)
    let loading = Task { await model.load() }
    await api.waitFor(.list(1))
    model.draft = "Submitted"
    XCTAssertFalse(model.canAdd)
    await model.add()
    let addedWhileLoading = await api.added
    XCTAssertTrue(addedWhileLoading.isEmpty)
    await api.finishList(1, .success([makeInstruction(id: "known")]))
    await loading.value
    XCTAssertTrue(model.canAdd)
    let saving = Task { await model.add() }
    await api.waitFor(.add)
    await api.finishAdd(makeInstruction(id: "saved", text: "Submitted"))
    await saving.value
    XCTAssertEqual(model.instructions.map(\.id), ["known", "saved"])
    XCTAssertEqual(model.state, .loaded)
  }

  func testAFailedInitialLoadKeepsAddBlockedUntilARetrySucceeds() async {
    let api = FakeInstructionAPI()
    await api.set(list: .failure(.api(.offline)))
    let model = InstructionsViewModel(api: api)
    await model.load()
    model.draft = "Submitted"
    XCTAssertFalse(model.canAdd)
    await api.set(list: .success([makeInstruction(id: "known")]))
    await model.load()
    XCTAssertTrue(model.canAdd)
  }

}
