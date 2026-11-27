import XCTest

@testable import B4MKit

final class BriefScheduleClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!
  private let schedule = BriefSchedule(
    enabled: true, timeOfDay: "07:30", days: [1, 3, 5], timeZone: "America/Los_Angeles")

  private func envelope(_ schedule: String) -> Data {
    Data(#"{"schedule":\#(schedule),"nextBriefAt":null}"#.utf8)
  }

  func testGetReadsTheSavedSchedule() async throws {
    let json = #"{"enabled":true,"timeOfDay":"07:30","days":[1,3,5],"timeZone":"America/Los_Angeles"}"#
    let response = envelope(json)
    let transport = FakeTransport { _ in (200, response) }
    let client = BriefScheduleClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let loaded = try await client.schedule()

    XCTAssertEqual(loaded, schedule)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/schedule")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
  }

  func testGetDecodesANeverSavedScheduleAsNil() async throws {
    let response = envelope("null")
    let transport = FakeTransport { _ in (200, response) }
    let client = BriefScheduleClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let loaded = try await client.schedule()
    XCTAssertNil(loaded)
  }

  func testPutSendsTheContractBody() async throws {
    let transport = FakeTransport { request in
      (200, Data(#"{"schedule":"#.utf8) + (request.httpBody ?? Data()) + Data("}".utf8))
    }
    let client = BriefScheduleClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let saved = try await client.save(schedule)

    XCTAssertEqual(saved, schedule)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/schedule")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(json["enabled"] as? Bool, true)
    XCTAssertEqual(json["timeOfDay"] as? String, "07:30")
    XCTAssertEqual(json["days"] as? [Int], [1, 3, 5])
    XCTAssertEqual(json["timeZone"] as? String, "America/Los_Angeles")
    XCTAssertEqual(json.count, 4)
  }

  func testServerErrorsSurfaceAsAPIError() async {
    let transport = FakeTransport { _ in (400, Data()) }
    let client = BriefScheduleClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.save(schedule)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, APIError(status: 400))
    }
  }
}
