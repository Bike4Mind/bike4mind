import XCTest

@testable import B4MKit

private let base = URL(string: "https://app.example.test")!

private func json(_ text: String) -> Data { Data(text.utf8) }

final class StepUpClientWireTests: XCTestCase {
  // Fixtures mirror apps/client/pages/api/auth/step-up/{index,options}.ts and email/send.ts.

  private func client(
    _ transport: FakeTransport, tokens: FakeTokens = FakeTokens()
  ) -> StepUpClient {
    StepUpClient(baseURL: base, tokens: tokens, transport: transport)
  }

  private func requestBody(_ transport: FakeTransport) async throws -> [String: String] {
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/auth/step-up")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    let data = try XCTUnwrap(request.httpBody)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
  }

  func testOptionsKeepOnlyMethodsThisAppCanCollect() async throws {
    let transport = FakeTransport { _ in
      (200, json(#"{"methods":["totp","passkey","future","password"],"stepUpUntil":null}"#))
    }
    let options = try await client(transport).fetchOptions()
    XCTAssertEqual(options, StepUpOptions(methods: [.totp, .password], stepUpUntil: nil))
    let requests = await transport.requests
    XCTAssertEqual(requests.first?.httpMethod, "GET")
    XCTAssertEqual(requests.first?.url?.path(), "/api/auth/step-up/options")
  }

  func testOptionsDecodeAnActiveWindow() async throws {
    let transport = FakeTransport { _ in
      (200, json(#"{"methods":["email"],"stepUpUntil":"2026-11-02T10:05:00.000Z"}"#))
    }
    let options = try await client(transport).fetchOptions()
    XCTAssertEqual(options.methods, [.email])
    XCTAssertEqual(options.stepUpUntil, Date(timeIntervalSince1970: 1_793_613_900))
  }

  func testPasskeyOnlyOptionsLeaveNothingToCollect() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"methods":["passkey"],"stepUpUntil":null}"#)) }
    let options = try await client(transport).fetchOptions()
    XCTAssertTrue(options.methods.isEmpty)
  }

  func testEmailSendReturnsThePendingToken() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"pendingToken":"abc_123"}"#)) }
    let token = try await client(transport).sendEmailCode()
    XCTAssertEqual(token, "abc_123")
    let requests = await transport.requests
    XCTAssertEqual(requests.first?.httpMethod, "POST")
    XCTAssertEqual(requests.first?.url?.path(), "/api/auth/step-up/email/send")
    XCTAssertNil(requests.first?.httpBody)
  }

  func testEmailSendRateLimitSurfacesAsAPIError() async {
    let transport = FakeTransport { _ in (429, Data()) }
    do {
      _ = try await client(transport).sendEmailCode()
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .rateLimited)
    }
  }

  func testEmailSendWithoutATokenIsMalformed() async {
    let transport = FakeTransport { _ in (200, json("{}")) }
    do {
      _ = try await client(transport).sendEmailCode()
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testEachMethodEncodesItsOwnBody() async throws {
    let ok = json(#"{"stepUpUntil":"2026-11-02T10:05:00.000Z"}"#)
    let cases: [(StepUpProof, [String: String])] = [
      (.password("hunter2"), ["method": "password", "password": "hunter2"]),
      (.totp("123456"), ["method": "totp", "code": "123456"]),
      (.email(pendingToken: "tok", code: "654321"), ["method": "email", "pendingToken": "tok", "code": "654321"]),
    ]
    for (proof, expected) in cases {
      let transport = FakeTransport { _ in (200, ok) }
      let until = try await client(transport).verify(proof)
      XCTAssertEqual(until, Date(timeIntervalSince1970: 1_793_613_900))
      let sent = try await requestBody(transport)
      XCTAssertEqual(sent, expected)
    }
  }

  func testRejectedProofCarriesAttemptsRemaining() async {
    let transport = FakeTransport { _ in
      (400, json(#"{"error":"Incorrect password.","code":"step_up_failed","attemptsRemaining":3}"#))
    }
    await assertVerify(
      client(transport), .password("x"), fails: .rejected(message: "Incorrect password.", attemptsRemaining: 3))
  }

  func testRejectedProofWithoutACounter() async {
    let transport = FakeTransport { _ in (400, json(#"{"error":"Verification failed.","code":"step_up_failed"}"#)) }
    await assertVerify(
      client(transport), .totp("000000"), fails: .rejected(message: "Verification failed.", attemptsRemaining: nil))
  }

  func testAnExhaustedEmailCodeIsRejectedNotSignedOut() async {
    let tokens = FakeTokens()
    let transport = FakeTransport { _ in
      (
        400,
        json(#"{"error":"This code has expired. Request a new one.","code":"step_up_failed","attemptsRemaining":0}"#)
      )
    }
    await assertVerify(
      client(transport, tokens: tokens), .email(pendingToken: "t", code: "1"),
      fails: .rejected(message: "This code has expired. Request a new one.", attemptsRemaining: 0))
    let rejections = await tokens.rejections
    XCTAssertEqual(rejections, 0)
  }

  func testTheFinalWrongPasswordEndsTheSessionLocally() async {
    let tokens = FakeTokens()
    let transport = FakeTransport { _ in
      (
        400,
        json(
          #"{"error":"Too many incorrect attempts. Please sign in again.","code":"step_up_failed","attemptsRemaining":0}"#
        )
      )
    }
    await assertVerify(client(transport, tokens: tokens), .password("x"), fails: .api(.signedOut))
    let rejections = await tokens.rejections
    XCTAssertEqual(rejections, 1)
  }

  func testARevokedSessionAnswers403Unavailable() async {
    let tokens = FakeTokens()
    let transport = FakeTransport { _ in (403, json(#"{"code":"step_up_unavailable","error":"Sign in again"}"#)) }
    await assertVerify(client(transport, tokens: tokens), .password("x"), fails: .api(.signedOut))
    let rejections = await tokens.rejections
    XCTAssertEqual(rejections, 1)
  }

  func testRateLimitAndLockoutBothReadAsRateLimited() async {
    for status in [429, 423] {
      let transport = FakeTransport { _ in (status, json(#"{"error":"Too many"}"#)) }
      await assertVerify(client(transport), .totp("123456"), fails: .rateLimited)
    }
  }

  func testOfflineSurfacesAsAPIFailure() async {
    let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
    await assertVerify(client(transport), .password("x"), fails: .api(.offline))
  }

  private func assertVerify(
    _ client: StepUpClient, _ proof: StepUpProof, fails expected: StepUpFailure,
    file: StaticString = #filePath, line: UInt = #line
  ) async {
    do {
      _ = try await client.verify(proof)
      XCTFail("expected failure", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? StepUpFailure, expected, file: file, line: line)
    }
  }
}

private actor ScriptedStepUpAPI: StepUpAPI {
  var options: Result<StepUpOptions, any Error>
  var emailToken: Result<String, any Error> = .success("pending-1")
  var verification: Result<Date, any Error> = .success(Date(timeIntervalSince1970: 1_800_000_300))
  private(set) var proofs: [StepUpProof] = []
  private(set) var sendCalls = 0

  init(options: Result<StepUpOptions, any Error>) { self.options = options }

  func setVerification(_ result: Result<Date, any Error>) { verification = result }
  func setEmailToken(_ result: Result<String, any Error>) { emailToken = result }

  func fetchOptions() async throws -> StepUpOptions { try options.get() }

  func sendEmailCode() async throws -> String {
    sendCalls += 1
    return try emailToken.get()
  }

  func verify(_ proof: StepUpProof) async throws -> Date {
    proofs.append(proof)
    return try verification.get()
  }
}

@MainActor
final class StepUpViewModelTests: XCTestCase {
  private var verifiedCount = 0

  private func makeModel(
    _ api: ScriptedStepUpAPI, now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 1_800_000_000) }
  ) -> StepUpViewModel {
    StepUpViewModel(api: api, now: now) { [weak self] in self?.verifiedCount += 1 }
  }

  private func options(_ methods: [StepUpMethod], until: Date? = nil) -> Result<StepUpOptions, any Error> {
    .success(StepUpOptions(methods: methods, stepUpUntil: until))
  }

  func testASingleMethodIsPickedAutomatically() async {
    let model = makeModel(ScriptedStepUpAPI(options: options([.password])))
    await model.load()
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(model.selectedMethod, .password)
    XCTAssertFalse(model.needsMethodPicker)
  }

  func testSeveralMethodsOfferAPickerStartingWithTheFirst() async {
    let model = makeModel(ScriptedStepUpAPI(options: options([.totp, .email])))
    await model.load()
    XCTAssertTrue(model.needsMethodPicker)
    XCTAssertEqual(model.selectedMethod, .totp)
    model.code = "123"
    model.select(.email)
    XCTAssertEqual(model.selectedMethod, .email)
    XCTAssertEqual(model.code, "")
  }

  func testNoUsableMethodIsReportedRatherThanShowingAnEmptyForm() async {
    let model = makeModel(ScriptedStepUpAPI(options: options([])))
    await model.load()
    XCTAssertEqual(model.phase, .noMethodAvailable)
  }

  func testLoadFailureIsRetryable() async {
    let model = makeModel(ScriptedStepUpAPI(options: .failure(APIError.offline)))
    await model.load()
    XCTAssertEqual(model.phase, .loadFailed(.offline))
  }

  func testAnOpenWindowSkipsStraightToVerified() async {
    let future = Date(timeIntervalSince1970: 1_800_000_100)
    let model = makeModel(ScriptedStepUpAPI(options: options([.password], until: future)))
    await model.load()
    XCTAssertEqual(model.phase, .verified)
    XCTAssertEqual(verifiedCount, 1)
  }

  func testAnExpiredWindowStillAsksForProof() async {
    let past = Date(timeIntervalSince1970: 1_799_999_000)
    let model = makeModel(ScriptedStepUpAPI(options: options([.password], until: past)))
    await model.load()
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(verifiedCount, 0)
  }

  func testPasswordSuccessTriggersTheRetryCallback() async {
    let api = ScriptedStepUpAPI(options: options([.password]))
    let model = makeModel(api)
    await model.load()
    XCTAssertFalse(model.canSubmit)
    model.password = "hunter2"
    XCTAssertTrue(model.canSubmit)
    await model.submit()
    let proofs = await api.proofs
    XCTAssertEqual(proofs, [.password("hunter2")])
    XCTAssertEqual(model.phase, .verified)
    XCTAssertEqual(verifiedCount, 1)
  }

  func testEmailNeedsACodeSentFirstAndKeepsThePendingToken() async {
    let api = ScriptedStepUpAPI(options: options([.email]))
    let model = makeModel(api)
    await model.load()
    model.code = "123456"
    XCTAssertFalse(model.canSubmit)
    XCTAssertNil(model.pendingToken)

    await model.sendEmailCode()
    XCTAssertEqual(model.pendingToken, "pending-1")
    model.code = " 123456 "
    XCTAssertTrue(model.canSubmit)
    await model.submit()
    let proofs = await api.proofs
    XCTAssertEqual(proofs, [.email(pendingToken: "pending-1", code: "123456")])
    XCTAssertEqual(verifiedCount, 1)
  }

  func testResendReplacesThePendingToken() async {
    let api = ScriptedStepUpAPI(options: options([.email]))
    let model = makeModel(api)
    await model.load()
    await model.sendEmailCode()
    await api.setEmailToken(.success("pending-2"))
    await model.sendEmailCode()
    XCTAssertEqual(model.pendingToken, "pending-2")
    let calls = await api.sendCalls
    XCTAssertEqual(calls, 2)
  }

  func testAFailedSendKeepsTheFormAndShowsAMessage() async {
    let api = ScriptedStepUpAPI(options: options([.email]))
    await api.setEmailToken(.failure(APIError.rateLimited))
    let model = makeModel(api)
    await model.load()
    await model.sendEmailCode()
    XCTAssertNil(model.pendingToken)
    XCTAssertNotNil(model.errorMessage)
    XCTAssertEqual(model.phase, .ready)
  }

  func testAWrongProofKeepsTheSheetAndShowsAttemptsRemaining() async {
    let api = ScriptedStepUpAPI(options: options([.password]))
    await api.setVerification(.failure(StepUpFailure.rejected(message: "Incorrect password.", attemptsRemaining: 2)))
    let model = makeModel(api)
    await model.load()
    model.password = "nope"
    await model.submit()
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(model.errorMessage, "Incorrect password. 2 attempts remaining.")
    XCTAssertEqual(model.password, "")
    XCTAssertEqual(verifiedCount, 0)
    XCTAssertFalse(model.isSubmitting)
  }

  func testRateLimitedShowsATryLaterMessage() async {
    let api = ScriptedStepUpAPI(options: options([.totp]))
    await api.setVerification(.failure(StepUpFailure.rateLimited))
    let model = makeModel(api)
    await model.load()
    model.code = "123456"
    await model.submit()
    XCTAssertEqual(model.errorMessage, "Too many attempts. Try again in a few minutes.")
    XCTAssertEqual(model.code, "123456")
    XCTAssertEqual(verifiedCount, 0)
  }
}
