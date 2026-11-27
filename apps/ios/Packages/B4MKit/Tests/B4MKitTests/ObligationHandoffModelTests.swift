import XCTest

@testable import B4MKit

private actor FakeObligationAPI: ObligationHandingOff {
  var handOffReplies: [Result<Obligation, any Error>]
  var updateReply: Result<Obligation, any Error>
  private(set) var handOffCalls: [(fileID: String, text: String?)] = []
  private(set) var patches: [ObligationPatch] = []

  init(handOff: [Result<Obligation, any Error>], update: Result<Obligation, any Error>) {
    handOffReplies = handOff
    updateReply = update
  }

  func setUpdateReply(_ reply: Result<Obligation, any Error>) { updateReply = reply }

  func createUpload(fileName: String, mimeType: String, byteCount: Int) async throws -> UploadTicket {
    UploadTicket(fileID: "file-1", uploadURL: URL(string: "https://upload.example.test/k")!, expiresAt: .distantFuture)
  }

  func fileStatus(fileID: String) async throws -> RemoteFileStatus { .clean }

  func handOff(fileID: String, text: String?) async throws -> Obligation {
    handOffCalls.append((fileID, text))
    return try handOffReplies.removeFirst().get()
  }

  func update(id: String, patch: ObligationPatch) async throws -> Obligation {
    patches.append(patch)
    return try updateReply.get()
  }
}

private struct FakeLakes: DestinationSource {
  func lakes() async throws -> [LakeSummary] {
    [
      LakeSummary(id: "lake-bills", name: "Bills", fileCount: 3, isBuiltIn: false),
      LakeSummary(id: "lake-home", name: "Home", fileCount: 1, isBuiltIn: false),
      LakeSummary(id: "lake-docs", name: "Product docs", fileCount: 9, isBuiltIn: true),
      LakeSummary(id: "lake-shared", name: "Shared", fileCount: 2, isBuiltIn: false, canManage: false),
    ]
  }
  func sessions() async throws -> [SessionSummary] { [] }
}

@MainActor
final class ObligationHandoffModelTests: XCTestCase {
  private let extracted = Obligation(
    id: "ob-1", fileID: "file-1", amount: ObligationAmount(value: Decimal(string: "120.50")!, currency: "USD"),
    payee: "City Water", dueDate: "2026-12-05", destination: ObligationDestination(lakeID: "lake-bills", name: "Bills"),
    summary: "Water bill")

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    return calendar
  }

  private func scanFile() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "scan-\(UUID().uuidString).pdf")
    try Data("%PDF-1.4".utf8).write(to: url)
    return url
  }

  private func model(
    _ api: FakeObligationAPI, text: String? = " Invoice 42 ", locale: String = "en_US"
  ) throws
    -> ObligationHandoffModel
  {
    ObligationHandoffModel(
      file: try scanFile(), text: text, api: api, destinations: FakeLakes(), put: { _, _, _ in },
      sleep: { _ in }, maximumPolls: 3, locale: Locale(identifier: locale), calendar: calendar)
  }

  func testExtractedFieldsFillTheSheetAndUnwritableLakesAreHidden() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    XCTAssertEqual(model.phase, .reviewing)
    XCTAssertEqual(model.amountText, "120.5")
    XCTAssertEqual(model.currency, "USD")
    XCTAssertEqual(model.payee, "City Water")
    XCTAssertEqual(model.destinationLakeID, "lake-bills")
    XCTAssertEqual(model.lakes.map(\.id), ["lake-bills", "lake-home"])
    let call = await api.handOffCalls.first
    XCTAssertEqual(call?.fileID, "file-1")
    XCTAssertEqual(call?.text, "Invoice 42")
  }

  func testLongOcrTextIsCutToTheServerLimit() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    let long = String(repeating: "a", count: ObligationHandoffModel.handOffTextLimit - 1) + "\u{1F600}tail"
    try await model(api, text: long).start()
    let text = await api.handOffCalls.first?.text
    XCTAssertEqual(text?.utf16.count, ObligationHandoffModel.handOffTextLimit - 1)
  }

  func testTextCapKeepsShortTextAndCountsUtf16() {
    XCTAssertEqual(ObligationHandoffModel.capHandOffText("abc", limit: 3), "abc")
    XCTAssertEqual(ObligationHandoffModel.capHandOffText("ab\u{1F600}", limit: 3), "ab")
    XCTAssertEqual(ObligationHandoffModel.capHandOffText("ab\u{1F600}", limit: 4), "ab\u{1F600}")
  }

  func testBlankOcrTextIsLeftForTheServerToRead() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    try await model(api, text: "  \n").start()
    let text = await api.handOffCalls.first?.text
    XCTAssertNil(text)
  }

  func testStillCheckingRetriesThenSucceeds() async throws {
    let api = FakeObligationAPI(
      handOff: [.failure(ObligationError.stillChecking), .success(extracted)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    XCTAssertEqual(model.phase, .reviewing)
    let calls = await api.handOffCalls.count
    XCTAssertEqual(calls, 2)
  }

  func testStillCheckingPastTheBudgetFails() async throws {
    let api = FakeObligationAPI(
      handOff: Array(repeating: .failure(ObligationError.stillChecking), count: 3), update: .success(extracted))
    let model = try model(api)
    await model.start()
    guard case .failed = model.phase else { return XCTFail("expected failure, got \(model.phase)") }
  }

  func testMissingFileFails() async throws {
    let api = FakeObligationAPI(handOff: [.failure(APIError.notFound)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    XCTAssertEqual(model.phase, .failed(message: "The scan couldn't be found. Please scan it again."))
  }

  func testAmountParsingFollowsTheLocale() {
    let us = Locale(identifier: "en_US")
    let de = Locale(identifier: "de_DE")
    XCTAssertEqual(ObligationHandoffModel.parseAmount("", locale: us), .success(nil))
    XCTAssertEqual(ObligationHandoffModel.parseAmount("1,234.50", locale: us), .success(Decimal(string: "1234.5")))
    XCTAssertEqual(ObligationHandoffModel.parseAmount("12,5", locale: de), .success(Decimal(string: "12.5")))
    XCTAssertEqual(ObligationHandoffModel.parseAmount("0", locale: us), .success(0))
    XCTAssertEqual(ObligationHandoffModel.parseAmount("-3", locale: us), .failure(.negative))
    XCTAssertEqual(ObligationHandoffModel.parseAmount("12abc", locale: us), .failure(.notANumber))
  }

  func testInvalidAmountBlocksConfirm() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    model.amountText = "-5"
    XCTAssertFalse(model.canConfirm)
    model.amountText = ""
    XCTAssertTrue(model.canConfirm)
  }

  func testConfirmSendsOnlyChangedFieldsPlusStatus() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    model.amountText = "99.99"
    model.destinationLakeID = "lake-home"
    await model.confirm()
    XCTAssertEqual(model.phase, .done)
    let patch = await api.patches.first
    XCTAssertEqual(
      patch,
      ObligationPatch(
        amount: .some(ObligationAmount(value: Decimal(string: "99.99")!, currency: "USD")),
        destinationLakeID: .some("lake-home"), status: "confirmed"))
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(XCTUnwrap(patch))) as? [String: Any]
    XCTAssertEqual(body.map { Set($0.keys) }, ["amount", "destination_lake_id", "status"])
  }

  func testUnchangedConfirmSendsStatusAndClearedFieldsSendNull() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    XCTAssertEqual(
      model.patch(against: extracted, amount: Decimal(string: "120.5")), ObligationPatch(status: "confirmed"))
    model.payee = "  "
    model.dueDate = nil
    let patch = model.patch(against: extracted, amount: Decimal(string: "120.5"))
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
    XCTAssertTrue(body?["payee"] is NSNull)
    XCTAssertTrue(body?["due_date"] is NSNull)
  }

  func testDueDateRoundTripsAsTheSameCalendarDay() async throws {
    let api = FakeObligationAPI(handOff: [.success(extracted)], update: .success(extracted))
    let model = try model(api)
    await model.start()
    XCTAssertEqual(model.patch(against: extracted, amount: Decimal(string: "120.5")).dueDate, nil)
    model.dueDate = calendar.date(from: DateComponents(year: 2026, month: 12, day: 6, hour: 23))
    XCTAssertEqual(model.patch(against: extracted, amount: Decimal(string: "120.5")).dueDate, .some("2026-12-06"))
  }

  func testFailedConfirmKeepsEditsForRetry() async throws {
    let api = FakeObligationAPI(
      handOff: [.success(extracted)], update: .failure(ObligationError.rejected(message: "Pick a lake you manage.")))
    let model = try model(api)
    await model.start()
    model.amountText = "80"
    model.payee = "City Water Dept"
    await model.confirm()
    XCTAssertEqual(model.phase, .reviewing)
    XCTAssertEqual(model.saveProblem, "Pick a lake you manage.")
    XCTAssertEqual(model.amountText, "80")
    XCTAssertEqual(model.payee, "City Water Dept")

    await api.setUpdateReply(.success(extracted))
    await model.confirm()
    XCTAssertEqual(model.phase, .done)
    XCTAssertNil(model.saveProblem)
    let patches = await api.patches
    XCTAssertEqual(patches.count, 2)
    XCTAssertEqual(patches[0], patches[1])
  }

  func testClientPostsHandOffAndDecodesTheObligation() async throws {
    let reply = """
      {"id":"ob-1","status":"pending","document_kind":"invoice","file_id":"file-1",
       "amount":{"value":120.5,"currency":"USD"},"payee":"City Water","due_date":"2026-12-05",
       "destination":{"lake_id":"lake-bills","name":"Bills"},"summary":"Water bill",
       "created_at":"2026-11-25T00:00:00.000Z","confirmed_at":null}
      """
    let transport = FakeTransport { _ in (201, Data(reply.utf8)) }
    let client = CaptureClient(
      baseURL: URL(string: "https://app.example.test")!, tokens: FakeTokens(), transport: transport)
    let obligation = try await client.handOff(fileID: "file-1", text: "Invoice")
    XCTAssertEqual(obligation, extracted)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/obligations")
    let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String]
    XCTAssertEqual(body, ["file_id": "file-1", "text": "Invoice"])

    await transport.respond { _ in (409, Data("{}".utf8)) }
    do {
      _ = try await client.handOff(fileID: "file-1", text: nil)
      XCTFail("expected stillChecking")
    } catch {
      XCTAssertEqual(error as? ObligationError, .stillChecking)
    }
  }

  func testClientMapsHandOffRejectionsToTheServersMessage() async throws {
    for status in [400, 422, 502] {
      let transport = FakeTransport { _ in (status, Data(#"{"error":"nothing readable"}"#.utf8)) }
      let client = CaptureClient(
        baseURL: URL(string: "https://app.example.test")!, tokens: FakeTokens(), transport: transport)
      do {
        _ = try await client.handOff(fileID: "file-1", text: nil)
        XCTFail("expected rejected for \(status)")
      } catch {
        XCTAssertEqual(error as? ObligationError, .rejected(message: "nothing readable"))
      }
    }
    let transport = FakeTransport { _ in (500, Data("{}".utf8)) }
    let client = CaptureClient(
      baseURL: URL(string: "https://app.example.test")!, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.handOff(fileID: "file-1", text: nil)
      XCTFail("expected a generic failure")
    } catch {
      XCTAssertEqual(error as? APIError, APIError(status: 500))
    }
  }

  func testClientMapsAConflictingPatchToDismissed() async throws {
    let transport = FakeTransport { _ in (409, Data("{}".utf8)) }
    let client = CaptureClient(
      baseURL: URL(string: "https://app.example.test")!, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.update(id: "ob-1", patch: ObligationPatch())
      XCTFail("expected dismissed")
    } catch {
      XCTAssertEqual(error as? ObligationError, .dismissed)
    }
  }

  func testDismissedAndOfflineFailuresShowTheirOwnMessages() async throws {
    let dismissed = FakeObligationAPI(handOff: [.success(extracted)], update: .failure(ObligationError.dismissed))
    let first = try model(dismissed)
    await first.start()
    await first.confirm()
    XCTAssertEqual(first.saveProblem, "This bill was dismissed and can't be changed.")
    XCTAssertEqual(first.phase, .reviewing)

    let offline = FakeObligationAPI(handOff: [.failure(APIError.offline)], update: .success(extracted))
    let second = try model(offline)
    await second.start()
    XCTAssertEqual(second.phase, .failed(message: "You're offline. Please try again when you're connected."))

    let generic = FakeObligationAPI(handOff: [.failure(APIError(status: 500))], update: .success(extracted))
    let third = try model(generic)
    await third.start()
    XCTAssertEqual(third.phase, .failed(message: "Something went wrong. Please try again."))
  }
}
