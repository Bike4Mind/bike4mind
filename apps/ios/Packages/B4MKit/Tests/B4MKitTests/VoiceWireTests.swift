import XCTest

@testable import B4MKit

private let base = URL(string: "https://app.example.test")!

private func json(_ text: String) -> Data { Data(text.utf8) }

private func client(_ transport: FakeTransport) -> VoiceClient {
  VoiceClient(baseURL: base, tokens: FakeTokens(), transport: transport)
}

private func voiceError(_ body: () async throws -> some Any) async -> VoiceWireError? {
  do {
    _ = try await body()
    return nil
  } catch {
    return error as? VoiceWireError
  }
}

final class VoiceWireTests: XCTestCase {
  // Fixtures mirror apps/client/pages/api/v1/client-config.ts, apps/client/pages/api/v1/voice/voices.ts
  // and apps/client/pages/api/ai/tts.ts.

  func testClientConfigReadsTheVoiceSessionsFlag() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"features":{"voice_sessions":true,"artifacts":false}}"#)) }
    let enabled = try await client(transport).voiceSessionsEnabled()
    XCTAssertTrue(enabled)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/client-config")
  }

  func testMissingVoiceSessionsKeyReadsAsOff() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"features":{}}"#)) }
    let enabled = try await client(transport).voiceSessionsEnabled()
    XCTAssertFalse(enabled)
  }

  func testClientConfigFailureIsTyped() async {
    let transport = FakeTransport { _ in (500, Data()) }
    let error = await voiceError { try await client(transport).voiceSessionsEnabled() }
    XCTAssertEqual(error, .server(status: 500))
  }

  func testVoicesParseWithAndWithoutPreviewURL() async throws {
    let body = json(
      #"{"voices":[{"id":"v1","name":"Alice","labels":{"accent":"british","gender":"female"},"previewUrl":"https://eleven.example/v1.mp3"},{"id":"v2","name":"Bob","labels":{}},{"id":"v3","name":"Cy","labels":{},"previewUrl":null},{"id":"v4","name":"Di","previewUrl":"not a url"}]}"#
    )
    let transport = FakeTransport { _ in (200, body) }
    let voices = try await client(transport).listVoices()

    XCTAssertEqual(voices.map(\.id), ["v1", "v2", "v3", "v4"])
    XCTAssertEqual(voices[0].labels, ["accent": "british", "gender": "female"])
    XCTAssertEqual(voices[0].previewURL, URL(string: "https://eleven.example/v1.mp3"))
    XCTAssertNil(voices[1].previewURL)
    XCTAssertNil(voices[2].previewURL)
    XCTAssertNil(voices[3].previewURL)
    XCTAssertEqual(voices[3].labels, [:])
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/v1/voice/voices")
  }

  func testAnEmptyCatalogIsNotAnError() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"voices":[]}"#)) }
    let voices = try await client(transport).listVoices()
    XCTAssertEqual(voices, [])
  }

  func testANonArrayCatalogIsMalformed() async {
    let transport = FakeTransport { _ in (200, json(#"{"voices":{"id":"v1"}}"#)) }
    let error = await voiceError { try await client(transport).listVoices() }
    XCTAssertEqual(error, .malformedResponse)
  }

  func testCatalogSwitchedOffOrUnconfiguredIsUnavailable() async {
    for status in [403, 503] {
      let transport = FakeTransport { _ in (status, json(#"{"error":"Voice v2 is not enabled"}"#)) }
      let error = await voiceError { try await client(transport).listVoices() }
      XCTAssertEqual(error, .unavailable, "status \(status)")
    }
  }

  func testSpeechRequestAsksForAPreviewClipInTheChosenVoice() async throws {
    let clip = Data([0xFF, 0xFB, 0x90, 0x00])
    let transport = FakeTransport { _ in (200, clip) }
    let audio = try await client(transport).synthesizeSpeech(text: "Hello there", voiceID: "v1")

    XCTAssertEqual(audio, clip)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/ai/tts")
    let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(sent["preview"] as? Bool, true)
    XCTAssertEqual(sent["voice"] as? String, "v1")
    XCTAssertEqual(sent["provider"] as? String, "elevenlabs")
    XCTAssertEqual(sent["format"] as? String, "mp3")
    XCTAssertEqual(sent["encoding"] as? String, "binary")
    XCTAssertEqual(sent["text"] as? String, "Hello there")
  }

  func testSpeechStatusesMapToTypedErrors() async {
    let cases: [(Int, Data, VoiceWireError)] = [
      (202, json(#"{"id":"job-1","status":"running"}"#), .pending),
      (403, Data(), .rejected(status: 403)),
      (404, Data(), .rejected(status: 404)),
      (413, Data(), .rejected(status: 413)),
      (422, json(#"{"error":"TTS request rejected"}"#), .rejected(status: 422)),
      (422, json(#"{"error":"Not enough credits","errorCode":"insufficient_credits"}"#), .insufficientCredits),
      (429, Data(), .rateLimited),
      (502, Data(), .server(status: 502)),
      (504, Data(), .server(status: 504)),
    ]
    for (status, body, expected) in cases {
      let transport = FakeTransport { _ in (status, body) }
      let error = await voiceError { try await client(transport).synthesizeSpeech(text: "Hi", voiceID: "v1") }
      XCTAssertEqual(error, expected, "status \(status)")
    }
  }

  func testAProviderCredentialFailureFallsBackWithoutEndingTheSession() async {
    let cases: [(String, VoiceWireError)] = [
      ("provider_not_configured", .unavailable),
      ("provider_rejected", .rejected(status: 401)),
    ]
    for (code, expected) in cases {
      let tokens = FakeTokens()
      let transport = FakeTransport { _ in (401, json(#"{"error":"TTS failed","errorCode":"\#(code)"}"#)) }
      let voice = VoiceClient(baseURL: base, tokens: tokens, transport: transport)
      let error = await voiceError { try await voice.synthesizeSpeech(text: "Hi", voiceID: "v1") }
      XCTAssertEqual(error, expected, code)
      let rejections = await tokens.rejections
      let invalidations = await tokens.invalidations
      XCTAssertEqual(rejections, 0, code)
      XCTAssertEqual(invalidations, 0, code)
      let sent = await transport.requests.count
      XCTAssertEqual(sent, 1, code)
    }
  }

  func testAnUncodedSpeech401StillEndsTheSession() async {
    let tokens = FakeTokens()
    let transport = FakeTransport { _ in (401, json(#"{"error":"Authentication required"}"#)) }
    let voice = VoiceClient(baseURL: base, tokens: tokens, transport: transport)
    let error = await voiceError { try await voice.synthesizeSpeech(text: "Hi", voiceID: "v1") }
    XCTAssertEqual(error, .signedOut)
    let rejections = await tokens.rejections
    XCTAssertEqual(rejections, 1)
  }

  func testSpeechOfflineIsTyped() async {
    let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
    let error = await voiceError { try await client(transport).synthesizeSpeech(text: "Hi", voiceID: "v1") }
    XCTAssertEqual(error, .offline)
  }

  func testSpeechRejectsANonAudioOrEmptySuccess() {
    let jsonBody = AuthorizedRequester.Response(
      status: 200, body: json(#"{"url":"x"}"#), contentType: "application/json")
    XCTAssertThrowsError(try VoiceWire.speech(jsonBody)) { XCTAssertEqual($0 as? VoiceWireError, .malformedResponse) }
    let empty = AuthorizedRequester.Response(status: 200, body: Data(), contentType: "audio/mpeg")
    XCTAssertThrowsError(try VoiceWire.speech(empty)) { XCTAssertEqual($0 as? VoiceWireError, .malformedResponse) }
    let audio = AuthorizedRequester.Response(status: 200, body: Data([1]), contentType: "audio/mpeg")
    XCTAssertEqual(try VoiceWire.speech(audio), Data([1]))
  }
}
