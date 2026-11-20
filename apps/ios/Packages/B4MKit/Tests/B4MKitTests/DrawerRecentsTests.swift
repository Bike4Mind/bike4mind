import XCTest

@testable import B4MKit

@MainActor
final class DrawerRecentsTests: XCTestCase {
  func testDrawerShowsTheFirstFiveSessionsInListOrder() async {
    let api = FakeAPI()
    let ids = ["a", "b", "c", "d", "e", "f", "g"]
    await api.setSessionPages([nil: Page(items: ids.map { Samples.session($0) }, nextCursor: nil)])
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache())

    await model.refresh()
    XCTAssertEqual(model.drawerRecents.map(\.id), ["a", "b", "c", "d", "e"])
  }

  func testDrawerShowsEverySessionWhenThereAreFewerThanFive() async {
    let api = FakeAPI()
    await api.setSessionPages([nil: Page(items: [Samples.session("a")], nextCursor: nil)])
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache())

    await model.refresh()
    XCTAssertEqual(model.drawerRecents.map(\.id), ["a"])
  }

  func testUnnamedSessionIsTitledUntitled() {
    let date = Date(timeIntervalSince1970: 0)
    let unnamed = SessionSummary(id: "u", name: "", lastUsedModel: nil, firstCreated: date, lastUpdated: date)
    XCTAssertEqual(unnamed.title, "Untitled")
    XCTAssertEqual(Samples.session("a").title, "Session a")
  }
}
