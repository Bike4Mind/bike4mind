import XCTest

@testable import B4MKit

private actor FakeInterruptionFeedbackAPI: InterruptionFeedbackAPI {
  private var stored: InterruptionFeedback
  private let failSave: Bool
  private(set) var patches: [InterruptionFeedback] = []

  init(stored: InterruptionFeedback = InterruptionFeedback(), failSave: Bool = false) {
    self.stored = stored
    self.failSave = failSave
  }

  func feedback() async throws -> InterruptionFeedback { stored }

  func save(_ patch: InterruptionFeedback) async throws -> InterruptionFeedback {
    patches.append(patch)
    if failSave { throw APIError(status: 500) }
    if let value = patch.agentCompleted { stored.agentCompleted = value }
    if let value = patch.agentFailed { stored.agentFailed = value }
    return stored
  }
}

final class InterruptionFeedbackClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  func testGetDecodesTheFeedbackEnvelope() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"feedback":{"agent_completed":true}}"#.utf8)) }
    let client = InterruptionFeedbackClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let feedback = try await client.feedback()

    XCTAssertEqual(feedback, InterruptionFeedback(agentCompleted: true))
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/assistant/interruptions")
  }

  func testGetDecodesUnsetFeedbackAsEmpty() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"feedback":{}}"#.utf8)) }
    let client = InterruptionFeedbackClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let feedback = try await client.feedback()

    XCTAssertEqual(feedback, InterruptionFeedback())
  }

  func testPutEncodesOnlyTheKeysThatAreSet() async throws {
    let reply = #"{"feedback":{"agent_completed":true,"agent_failed":false}}"#
    let transport = FakeTransport { _ in (200, Data(reply.utf8)) }
    let client = InterruptionFeedbackClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let saved = try await client.save(InterruptionFeedback(agentFailed: false))

    XCTAssertEqual(saved, InterruptionFeedback(agentCompleted: true, agentFailed: false))
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(request.url?.path(), "/api/v1/assistant/interruptions")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(Set(json.keys), ["agent_failed"])
    XCTAssertEqual(json["agent_failed"] as? Bool, false)
  }

  func testServerErrorsSurfaceAsAPIError() async {
    let transport = FakeTransport { _ in (400, Data()) }
    let client = InterruptionFeedbackClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.save(InterruptionFeedback(agentCompleted: true))
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, APIError(status: 400))
    }
  }

  func testMalformedBodyIsAMalformedResponse() async {
    let transport = FakeTransport { _ in (200, Data(#"{"agent_completed":true}"#.utf8)) }
    let client = InterruptionFeedbackClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.feedback()
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  @MainActor
  func testSetQuietSendsOneCategoryAndKeepsTheServerState() async {
    let api = FakeInterruptionFeedbackAPI(stored: InterruptionFeedback(agentFailed: true))
    let vm = InterruptionFeedbackViewModel(api: api)
    await vm.load()

    await vm.setQuiet(.agentCompleted, true)

    XCTAssertTrue(vm.isQuiet(.agentCompleted))
    XCTAssertTrue(vm.isQuiet(.agentFailed))
    let patches = await api.patches
    XCTAssertEqual(patches, [InterruptionFeedback(agentCompleted: true)])
    XCTAssertNil(vm.errorMessage)
  }

  @MainActor
  func testSetQuietRollsBackWhenTheSaveFails() async {
    let api = FakeInterruptionFeedbackAPI(failSave: true)
    let vm = InterruptionFeedbackViewModel(api: api)
    await vm.load()

    await vm.setQuiet(.agentFailed, true)

    XCTAssertFalse(vm.isQuiet(.agentFailed))
    XCTAssertEqual(vm.feedback, InterruptionFeedback())
    XCTAssertNotNil(vm.errorMessage)
    XCTAssertFalse(vm.isSaving)
  }

  @MainActor
  func testLoadFailureLeavesTheTogglesUnloaded() async {
    struct Failing: InterruptionFeedbackAPI {
      func feedback() async throws -> InterruptionFeedback { throw APIError(status: 503) }
      func save(_ patch: InterruptionFeedback) async throws -> InterruptionFeedback { patch }
    }
    let vm = InterruptionFeedbackViewModel(api: Failing())

    await vm.load()

    XCTAssertFalse(vm.isLoaded)
    XCTAssertNotNil(vm.errorMessage)
  }
}
