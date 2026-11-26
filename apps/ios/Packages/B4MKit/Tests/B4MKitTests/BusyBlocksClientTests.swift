import XCTest

@testable import B4MKit

final class BusyBlocksClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!
  private let start = Date(timeIntervalSince1970: 1_800_000_000)

  func testGetDecodesMillisecondDatesAndNullNextBrief() async throws {
    let json =
      #"{"enabled":true,"blocks":[{"start":"2027-01-15T08:00:00.000Z","end":"2027-01-15T09:30:00Z"}],"nextBlockBriefAt":null}"#
    let transport = FakeTransport { _ in (200, Data(json.utf8)) }
    let client = BusyBlocksClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let state = try await client.state()

    XCTAssertTrue(state.enabled)
    XCTAssertNil(state.nextBlockBriefAt)
    XCTAssertEqual(state.blocks.count, 1)
    XCTAssertEqual(state.blocks[0].end.timeIntervalSince(state.blocks[0].start), 90 * 60)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/busy-blocks")
  }

  func testPutSendsOnlyTimesInTheContractBody() async throws {
    let reply = #"{"enabled":true,"blocks":[],"nextBlockBriefAt":"2027-01-15T09:30:00.000Z"}"#
    let transport = FakeTransport { _ in (200, Data(reply.utf8)) }
    let client = BusyBlocksClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let block = BusyBlock(start: start, end: start.addingTimeInterval(1800))

    let saved = try await client.save(enabled: true, blocks: [block])

    XCTAssertNotNil(saved.nextBlockBriefAt)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "PUT")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(Set(json.keys), ["enabled", "blocks"])
    let blocks = try XCTUnwrap(json["blocks"] as? [[String: Any]])
    XCTAssertEqual(Set(blocks[0].keys), ["start", "end"])
    XCTAssertEqual(blocks[0]["start"] as? String, "2027-01-15T08:00:00.000Z")
    XCTAssertEqual(blocks[0]["end"] as? String, "2027-01-15T08:30:00.000Z")
  }

  func testServerErrorsSurfaceAsAPIError() async {
    let transport = FakeTransport { _ in (400, Data()) }
    let client = BusyBlocksClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.save(enabled: false, blocks: [])
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, APIError(status: 400))
    }
  }

  func testFilterDropsAllDayFreeInvertedAndOverlongEvents() {
    let hour: TimeInterval = 3600
    func event(
      _ offset: TimeInterval, _ length: TimeInterval, allDay: Bool = false,
      _ availability: CalendarEventSample.Availability = .busy
    )
      -> CalendarEventSample
    {
      CalendarEventSample(
        start: start.addingTimeInterval(offset), end: start.addingTimeInterval(offset + length), isAllDay: allDay,
        availability: availability)
    }
    let events = [
      event(5 * hour, hour, .tentative),
      event(0, hour),
      event(0, 24 * hour, allDay: true),
      event(2 * hour, hour, .free),
      event(3 * hour, 0),
      event(0, 12 * hour + 1),
      event(0, 12 * hour, .unavailable),
      event(4 * hour, hour, .notSupported),
    ]

    let blocks = BusyBlockFilter.blocks(from: events)

    XCTAssertEqual(blocks.map { $0.start.timeIntervalSince(start) / hour }, [0, 4, 5, 0])
    XCTAssertEqual(blocks.last?.end, start.addingTimeInterval(12 * hour))
  }

  func testFilterKeepsTheEarliestEndingBlocksUpToTheServerCap() {
    let events = (0..<60).reversed().map { index in
      CalendarEventSample(
        start: start.addingTimeInterval(Double(index) * 600),
        end: start.addingTimeInterval(Double(index) * 600 + 300), isAllDay: false, availability: .busy)
    }

    let blocks = BusyBlockFilter.blocks(from: events)

    XCTAssertEqual(blocks.count, BusyBlockFilter.maxBlocks)
    XCTAssertEqual(blocks.first?.start, start)
    XCTAssertEqual(blocks.last?.start, start.addingTimeInterval(47 * 600))
  }
}
