import XCTest

@testable import B4MKit

final class CaptureClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  private func client(_ transport: FakeTransport, tokens: FakeTokens = FakeTokens()) -> CaptureClient {
    CaptureClient(baseURL: base, tokens: tokens, transport: transport)
  }

  private func json(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testCreateUploadPostsTheContractBodyAndParsesTheTicket() async throws {
    let transport = FakeTransport { _ in
      (
        201,
        Data(
          #"{"id":"f1","upload_url":"https://bucket.s3.amazonaws.com/k?X-Amz-Signature=abc","upload_url_expires_at":"2026-11-02T12:10:00.000Z"}"#
            .utf8)
      )
    }
    let ticket = try await client(transport).createUpload(
      fileName: "a b.pdf", mimeType: "application/pdf", byteCount: 42)

    XCTAssertEqual(ticket.fileID, "f1")
    XCTAssertEqual(ticket.uploadURL.host(), "bucket.s3.amazonaws.com")
    XCTAssertEqual(ticket.expiresAt, Date(timeIntervalSince1970: 1_793_621_400))
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/files")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    let body = try json(request)
    XCTAssertEqual(body["file_name"] as? String, "a b.pdf")
    XCTAssertEqual(body["mime_type"] as? String, "application/pdf")
    XCTAssertEqual(body["file_size"] as? Int, 42)
  }

  func testCreateUploadSurfacesAStorageRefusalWithTheServersMessage() async {
    let transport = FakeTransport { _ in
      (400, Data(#"{"error":"File size exceeds maximum file size","errorCode":"file_too_large"}"#.utf8))
    }
    do {
      _ = try await client(transport).createUpload(fileName: "x", mimeType: "x/y", byteCount: 1)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? CaptureError, .rejected(message: "File size exceeds maximum file size"))
    }
  }

  func testCreateUploadRejectsAnUnreadableTicket() async {
    let transport = FakeTransport { _ in (201, Data(#"{"id":"f1"}"#.utf8)) }
    do {
      _ = try await client(transport).createUpload(fileName: "x", mimeType: "x/y", byteCount: 1)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testFileStatusMapsModerationStates() async throws {
    for (raw, expected) in [
      ("pending", RemoteFileStatus.pending), ("scanning", .scanning), ("clean", .clean), ("blocked", .blocked),
    ] {
      let transport = FakeTransport { _ in (200, Data(#"{"id":"f1","moderation_status":"\#(raw)"}"#.utf8)) }
      let status = try await client(transport).fileStatus(fileID: "f1")
      XCTAssertEqual(status, expected)
      let requests = await transport.requests
      XCTAssertEqual(requests.first?.httpMethod, "GET")
      XCTAssertEqual(requests.first?.url?.path(), "/api/v1/files/f1")
    }
    let legacy = FakeTransport { _ in (200, Data(#"{"id":"f1","moderation_status":null}"#.utf8)) }
    let legacyStatus = try await client(legacy).fileStatus(fileID: "f1")
    XCTAssertEqual(legacyStatus, .unscanned)
  }

  func testSetNotesPatchesTheFile() async throws {
    let transport = FakeTransport { _ in (200, Data("{}".utf8)) }
    try await client(transport).setNotes(fileID: "f1", notes: "from the trail")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "PATCH")
    XCTAssertEqual(request.url?.path(), "/api/v1/files/f1")
    XCTAssertEqual(try json(request)["notes"] as? String, "from the trail")
  }

  func testListLakesSendsPaginationAndMapsTheFields() async throws {
    let transport = FakeTransport { _ in
      (
        200,
        Data(
          #"{"data":[{"id":"l1","name":"Research","slug":"research","file_count":3,"built_in":false},{"id":"l2","name":"Docs","slug":"docs","file_count":0,"built_in":true}],"next_cursor":"c2"}"#
            .utf8)
      )
    }
    let page = try await client(transport).listLakes(cursor: "c1", limit: 50)
    XCTAssertEqual(
      page.items,
      [
        LakeSummary(id: "l1", name: "Research", fileCount: 3, isBuiltIn: false),
        LakeSummary(id: "l2", name: "Docs", fileCount: 0, isBuiltIn: true),
      ])
    XCTAssertEqual(page.nextCursor, "c2")
    let requests = await transport.requests
    let url = try XCTUnwrap(requests.first?.url)
    XCTAssertEqual(url.path(), "/api/v1/data-lakes")
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    XCTAssertEqual(items?.first { $0.name == "limit" }?.value, "50")
    XCTAssertEqual(items?.first { $0.name == "cursor" }?.value, "c1")
  }

  func testListLakesOmitsAnAbsentCursor() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"data":[],"next_cursor":null}"#.utf8)) }
    _ = try await client(transport).listLakes(cursor: nil, limit: 25)
    let requests = await transport.requests
    XCTAssertNil(requests.first?.url?.query()?.range(of: "cursor"))
  }

  func testListLakesForbiddenWhenTheFeatureIsOff() async {
    let transport = FakeTransport { _ in (403, Data(#"{"error":"Feature not available"}"#.utf8)) }
    do {
      _ = try await client(transport).listLakes(cursor: nil, limit: 25)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .forbidden)
    }
  }

  func testAddFileToLakeIsABodylessPost() async throws {
    let transport = FakeTransport { _ in (200, Data("{}".utf8)) }
    try await client(transport).addFileToLake(lakeID: "l1", fileID: "f1")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/data-lakes/l1/files/f1")
    XCTAssertNil(request.httpBody)
  }

  func testAddFileToLakeMapsNotFoundAndPolicyRefusals() async {
    let missing = FakeTransport { _ in (404, Data()) }
    do {
      try await client(missing).addFileToLake(lakeID: "l1", fileID: "f1")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .notFound)
    }
    let policy = FakeTransport { _ in (400, Data(#"{"error":"chunk size not accepted"}"#.utf8)) }
    do {
      try await client(policy).addFileToLake(lakeID: "l1", fileID: "f1")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? CaptureError, .rejected(message: "chunk size not accepted"))
    }
  }

  func testSessionMessageCarriesFileIDsOnTheChatRoute() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"id":"q1","sessionId":"s1"}"#.utf8)) }
    try await client(transport).sendSessionMessage(sessionID: "s1", message: "look", fileIDs: ["f1", "f2"])
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/chat")
    let body = try json(request)
    XCTAssertEqual(body["sessionId"] as? String, "s1")
    XCTAssertEqual(body["message"] as? String, "look")
    XCTAssertEqual(body["fileIds"] as? [String], ["f1", "f2"])
  }

  func testSessionMessageRefusedUpFrontIsAnError() async {
    let transport = FakeTransport { _ in
      (200, Data(#"{"id":"q1","type":"error","errorCode":"insufficient_credits","message":"Not enough credits"}"#.utf8))
    }
    do {
      try await client(transport).sendSessionMessage(sessionID: "s1", message: "hi", fileIDs: [])
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? CaptureError, .turnRefused(message: "Not enough credits"))
    }
  }

  func testA401RefreshesOnceThenRetries() async throws {
    let transport = FakeTransport { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1" ? (401, Data()) : (200, Data("{}".utf8))
    }
    let tokens = FakeTokens()
    try await client(transport, tokens: tokens).addFileToLake(lakeID: "l1", fileID: "f1")
    let count = await transport.requests.count
    let invalidations = await tokens.invalidations
    XCTAssertEqual(count, 2)
    XCTAssertEqual(invalidations, 1)
  }

  func testASecond401EndsTheSession() async {
    let transport = FakeTransport { _ in (401, Data()) }
    let tokens = FakeTokens()
    do {
      try await client(transport, tokens: tokens).setNotes(fileID: "f", notes: "n")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .signedOut)
    }
    let rejections = await tokens.rejections
    XCTAssertEqual(rejections, 1)
  }
}

final class ChatSendWireAttachmentTests: XCTestCase {
  func testFilesAreSentAsFileIds() throws {
    let body = try ChatSendWire.body(for: ChatSendRequest(message: "hi", target: .session("s1"), fileIDs: ["a"]))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["fileIds"] as? [String], ["a"])
  }

  func testNoFilesLeavesTheBodyUnchanged() throws {
    let body = try ChatSendWire.body(for: ChatSendRequest(message: "hi", target: .session("s1")))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertNil(object["fileIds"])
  }
}
