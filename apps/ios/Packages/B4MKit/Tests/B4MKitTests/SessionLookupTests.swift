import XCTest

@testable import B4MKit

final class SessionLookupTests: XCTestCase {
  func testFindsSessionsBeyondTheFirstPage() async throws {
    let api = FakeAPI()
    await api.setSessionPages([
      nil: Page(items: [Samples.session("a"), Samples.session("b")], nextCursor: "p2"),
      "p2": Page(items: [Samples.session("c")], nextCursor: "p3"),
      "p3": Page(items: [Samples.session("d")], nextCursor: nil),
    ])

    let found = try await SessionLookup.sessions(withIDs: ["a", "c"], api: api)

    XCTAssertEqual(found.map(\.id), ["a", "c"])
    let cursors = await api.sessionCursors
    XCTAssertEqual(cursors, [nil, "p2"], "the scan stops once every id is found")
  }

  func testTheScanIsBounded() async throws {
    let api = FakeAPI()
    await api.setSessionPages([
      nil: Page(items: [Samples.session("a")], nextCursor: "p2"),
      "p2": Page(items: [Samples.session("b")], nextCursor: "p3"),
    ])

    let found = try await SessionLookup.sessions(withIDs: ["missing"], api: api, maxPages: 2)

    XCTAssertTrue(found.isEmpty)
    let cursors = await api.sessionCursors
    XCTAssertEqual(cursors, [nil, "p2"])
  }

  @MainActor
  func testNameComesFromTheListThenFromTheFirstPrompt() async {
    let api = FakeAPI()
    await api.setSessionPages([nil: Page(items: [Samples.session("a")], nextCursor: nil)])
    let named = await SessionLookup.name(forSession: "a", api: api, cache: nil, turns: [])
    XCTAssertEqual(named, "Session a")

    let turns = [Samples.quest("q1", prompt: "  Plan a weekend in Kyoto  ", reply: nil, status: .done)]
    let derived = await SessionLookup.name(forSession: "unlisted", api: api, cache: nil, turns: turns)
    XCTAssertEqual(derived, "Plan a weekend in Kyoto")

    let none = await SessionLookup.name(forSession: "unlisted", api: api, cache: nil, turns: [])
    XCTAssertNil(none)
  }
}
