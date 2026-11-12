import XCTest

@testable import B4MKit

final class AssistantIntentRoutingTests: XCTestCase {
  func testAskOpensANewConversationWithTheTrimmedPromptAsADraft() {
    XCTAssertEqual(
      AssistantRequest.ask(prompt: "  What changed this week?\n").route,
      .compose(ComposeRequest(target: .newConversation, draft: "What changed this week?")))
  }

  func testAskWithNothingSaidStillOpensTheComposer() {
    XCTAssertEqual(
      AssistantRequest.ask(prompt: "   ").route, .compose(ComposeRequest(target: .newConversation, draft: "")))
  }

  func testStartQuestOpensTheNamedSessionWithoutADraft() {
    XCTAssertEqual(
      AssistantRequest.startQuest(sessionID: "abc123").route,
      .compose(ComposeRequest(target: .session(id: "abc123"), draft: "")))
  }

  func testStartQuestWithAMalformedSessionIdFallsBackToTheSessionsList() {
    XCTAssertEqual(AssistantRequest.startQuest(sessionID: "../etc").route, .sessions)
    XCTAssertEqual(AssistantRequest.startQuest(sessionID: "").route, .sessions)
  }

  func testCaptureNotePrefillsADraftThatNamesTheLake() {
    XCTAssertEqual(
      AssistantRequest.captureNote(text: " Remember the Q3 numbers ").route,
      .compose(
        ComposeRequest(
          target: .newConversation, draft: AssistantRequest.captureNotePrefix + "Remember the Q3 numbers")))
  }

  func testCaptureOfAnEmptyNoteDoesNotInventContent() {
    XCTAssertEqual(
      AssistantRequest.captureNote(text: "").route, .compose(ComposeRequest(target: .newConversation, draft: "")))
  }

  func testComposeRoutesTargetTheHomeStack() {
    XCTAssertEqual(
      AssistantRequest.ask(prompt: "x").route, .compose(ComposeRequest(target: .newConversation, draft: "x")))
  }
}

@MainActor
final class ComposeNavigationTests: XCTestCase {
  func testNewConversationRequestLandsOnHomeAndIsTakenOnce() {
    let navigator = AppNavigator()
    navigator.apply(.media)
    navigator.apply(AssistantRequest.ask(prompt: "hi").route)
    XCTAssertTrue(navigator.isShowing(.home))
    XCTAssertEqual(navigator.takeNewConversationRequest()?.draft, "hi")
    XCTAssertNil(navigator.newConversationRequest)
  }

  func testSessionRequestPushesTheSessionAndIsTakenExactlyOnce() {
    let navigator = AppNavigator()
    navigator.apply(AssistantRequest.startQuest(sessionID: "s1").route)
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s1"])
    XCTAssertNil(navigator.newConversationRequest)
    XCTAssertNil(navigator.takeComposeRequest(forSession: "other"))
    XCTAssertNotNil(navigator.takeComposeRequest(forSession: "s1"))
    XCTAssertNil(navigator.takeComposeRequest(forSession: "s1"))
  }

  func testRequestForTheSessionAlreadyOpenDoesNotRestackIt() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "s1"))
    navigator.apply(.compose(ComposeRequest(target: .session(id: "s1"), draft: "go")))
    XCTAssertEqual(navigator.sessionPath.count, 1)
    XCTAssertEqual(navigator.takeComposeRequest(forSession: "s1")?.draft, "go")
  }

  func testAnIntentArrivingBeforeSignInWaitsForTheShell() {
    let navigator = AppNavigator()
    navigator.open(AssistantRequest.ask(prompt: "hi").route, isShellReady: false)
    XCTAssertNil(navigator.newConversationRequest)
    navigator.releasePendingRoute()
    XCTAssertEqual(navigator.newConversationRequest?.draft, "hi")
  }

  func testComposeIsNeverTheScreenTheUserIsAlreadyLookingAt() {
    XCTAssertFalse(AppNavigator().isShowing(.compose(ComposeRequest(target: .newConversation))))
  }
}

@MainActor
final class IntentDeliveryTests: XCTestCase {
  func testRouteIsQueuedUntilTheShellIsReadyThenApplied() {
    let navigator = AppNavigator()
    var ready = false
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { ready })
    handler.open(AssistantRequest.ask(prompt: "hi").route)
    XCTAssertNil(navigator.newConversationRequest)
    ready = true
    navigator.releasePendingRoute()
    XCTAssertEqual(navigator.newConversationRequest?.draft, "hi")
  }

  func testRouteIsAppliedImmediatelyWhenTheShellIsReady() {
    let navigator = AppNavigator()
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { true })
    handler.open(AssistantRequest.startQuest(sessionID: "s1").route)
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s1"])
  }
}

@MainActor
final class NewConversationViewModelTests: XCTestCase {
  func testSendCreatesAConversationAndReturnsItsSessionId() async {
    let api = FakeAPI()
    await api.setSendResult(.success(ChatSendReceipt(questID: "q1", sessionID: "new-session")))
    let model = NewConversationViewModel(draft: " Plan my week ", api: api)
    let sessionID = await model.send()
    XCTAssertEqual(sessionID, "new-session")
    XCTAssertEqual(model.draft, "")
    let sent = await api.sentMessages
    XCTAssertEqual(sent, [ChatSendRequest(message: "Plan my week", target: .newConversation)])
  }

  func testFailureKeepsTheDraftSoNothingTypedIsLost() async {
    let api = FakeAPI()
    await api.setSendResult(.failure(.offline))
    let model = NewConversationViewModel(draft: "Plan my week", api: api)
    let sessionID = await model.send()
    XCTAssertNil(sessionID)
    XCTAssertEqual(model.draft, "Plan my week")
    XCTAssertEqual(model.failure, .offline)
  }

  func testAServerRefusalIsReportedWithItsReason() async {
    let api = FakeAPI()
    await api.setSendResult(
      .success(
        ChatSendReceipt(
          questID: "q1", sessionID: "s", kind: .error, errorCode: .insufficientCredits, message: "Out of credits")))
    let model = NewConversationViewModel(draft: "hello", api: api)
    let sessionID = await model.send()
    XCTAssertNil(sessionID)
    XCTAssertEqual(model.refusal, "Out of credits")
    XCTAssertEqual(model.draft, "hello")
  }

  func testAReceiptWithoutASessionIsMalformed() async {
    let api = FakeAPI()
    await api.setSendResult(.success(ChatSendReceipt(questID: "q1", sessionID: nil)))
    let model = NewConversationViewModel(draft: "hello", api: api)
    let sessionID = await model.send()
    XCTAssertNil(sessionID)
    XCTAssertEqual(model.failure, .malformedResponse)
  }

  func testEmptyDraftCannotBeSent() async {
    let api = FakeAPI()
    let model = NewConversationViewModel(draft: "  ", api: api)
    XCTAssertFalse(model.canSend)
    let sessionID = await model.send()
    XCTAssertNil(sessionID)
    let sent = await api.sentMessages
    XCTAssertTrue(sent.isEmpty)
  }
}
