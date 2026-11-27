import XCTest

@testable import B4MKit

final class SessionLookupTests: XCTestCase {
  func testFetchesEachRequestedIDWithoutListingPages() async throws {
    let api = FakeAPI()
    await api.setSessions([Samples.session("a"), Samples.session("c")])

    let found = try await SessionLookup.sessions(withIDs: ["a", "c"], api: api)

    XCTAssertEqual(found.map(\.id), ["a", "c"])
    let cursors = await api.sessionCursors
    XCTAssertTrue(cursors.isEmpty)
    let lookups = await api.sessionLookups
    XCTAssertEqual(lookups, ["a", "c"])
  }

  func testMissingIDsAreOmitted() async throws {
    let api = FakeAPI()
    await api.setSessions([Samples.session("a")])

    let found = try await SessionLookup.sessions(withIDs: ["a", "missing"], api: api)

    XCTAssertEqual(found.map(\.id), ["a"])
    let cursors = await api.sessionCursors
    XCTAssertTrue(cursors.isEmpty)
  }

  @MainActor
  func testColdNameUsesOneDirectRequestThenFallsBackToTheFirstPrompt() async {
    let api = FakeAPI()
    await api.setSessions([Samples.session("a")])
    let named = await SessionLookup.name(forSession: "a", api: api, cache: nil, turns: [])
    XCTAssertEqual(named, "Session a")
    let lookups = await api.sessionLookups
    XCTAssertEqual(lookups, ["a"])
    let cursors = await api.sessionCursors
    XCTAssertTrue(cursors.isEmpty)

    let turns = [Samples.quest("q1", prompt: "  Plan a weekend in Kyoto  ", reply: nil, status: .done)]
    let derived = await SessionLookup.name(forSession: "unlisted", api: api, cache: nil, turns: turns)
    XCTAssertEqual(derived, "Plan a weekend in Kyoto")

    let none = await SessionLookup.name(forSession: "unlisted", api: api, cache: nil, turns: [])
    XCTAssertNil(none)
  }
}
