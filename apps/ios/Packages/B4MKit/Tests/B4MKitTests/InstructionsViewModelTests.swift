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
