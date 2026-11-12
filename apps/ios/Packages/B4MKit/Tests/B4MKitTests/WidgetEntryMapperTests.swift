import XCTest

@testable import B4MKit

final class WidgetEntryMapperTests: XCTestCase {
  private let locale = Locale(identifier: "en_US")

  private func mapper(_ snapshot: WidgetSnapshot?, at offset: TimeInterval = 0) -> WidgetEntryMapper {
    WidgetEntryMapper(snapshot: snapshot, now: referenceDate.addingTimeInterval(offset), locale: locale)
  }

  private func running(
    count: Int = 2, status: String = "running", title: String = "Metrics", observedAt: Date = referenceDate
  ) -> WidgetSnapshot {
    WidgetSnapshot(
      runningAgents: .init(
        count: count, top: count > 0 ? .init(sessionID: "s1", title: title, status: status) : nil,
        observedAt: observedAt))
  }

  // MARK: Running agents

  func testNoSnapshotYieldsPlaceholders() {
    XCTAssertEqual(mapper(nil).runningAgents(), .placeholder)
    XCTAssertEqual(mapper(nil).credits(), .placeholder)
    XCTAssertEqual(mapper(nil).latestGeneration(), .placeholder)
    XCTAssertEqual(mapper(.empty).runningAgents(), .placeholder)
  }

  func testActiveAgentsShowCountTopTitleAndStatus() {
    XCTAssertEqual(
      mapper(running(), at: 60).runningAgents(),
      .active(count: 2, topTitle: "Metrics", topStatus: "Working", sessionID: "s1"))
  }

  func testStatusLabelsAreHumanReadable() {
    XCTAssertEqual(WidgetEntryMapper.statusLabel("approval"), "Needs approval")
    XCTAssertEqual(WidgetEntryMapper.statusLabel("pending"), "Queued")
    XCTAssertEqual(WidgetEntryMapper.statusLabel("anything-new"), "Working")
  }

  func testZeroRunningIsIdle() {
    XCTAssertEqual(mapper(running(count: 0), at: 10).runningAgents(), .idle)
  }

  func testOldObservationBecomesStaleInsteadOfClaimingAgentsAreStillRunning() {
    let offset = WidgetEntryMapper.runningAgentsFreshness + 1
    XCTAssertEqual(mapper(running(), at: offset).runningAgents(), .stale(observedAt: referenceDate))
  }

  func testObservationAtTheFreshnessBoundaryIsStillFresh() {
    let display = mapper(running(), at: WidgetEntryMapper.runningAgentsFreshness).runningAgents()
    guard case .active = display else { return XCTFail("expected active, got \(display)") }
  }

  func testBlankSessionTitleFallsBackToUntitled() {
    guard case .active(_, let title, _, _) = mapper(running(title: "  "), at: 1).runningAgents() else {
      return XCTFail("expected active")
    }
    XCTAssertEqual(title, "Untitled")
  }

  func testNextRefreshLandsJustAfterRunningDataGoesStale() {
    let next = mapper(running(), at: 60).nextRefresh()
    XCTAssertEqual(next, referenceDate.addingTimeInterval(WidgetEntryMapper.runningAgentsFreshness + 1))
  }

  func testNextRefreshIsHourlyWithNothingToExpire() {
    XCTAssertEqual(mapper(nil).nextRefresh(), referenceDate.addingTimeInterval(3_600))
    let old = mapper(running(), at: 3 * 3_600).nextRefresh()
    XCTAssertEqual(old, referenceDate.addingTimeInterval(4 * 3_600))
  }

  // MARK: Credits

  func testCreditsAreFormattedWithGroupingAndFlaggedWhenOld() {
    let snapshot = WidgetSnapshot(credits: .init(balance: 31_667.4, observedAt: referenceDate))
    XCTAssertEqual(
      mapper(snapshot, at: 60).credits(), .balance(formatted: "31,667", value: 31_667.4, isStale: false))
    let later = WidgetEntryMapper.creditsFreshness + 1
    XCTAssertEqual(
      mapper(snapshot, at: later).credits(), .balance(formatted: "31,667", value: 31_667.4, isStale: true))
  }

  func testCompactCreditsForTightSpaces() {
    XCTAssertEqual(CreditsFormat.compact(31_667, locale: locale), "31.7K")
    XCTAssertEqual(CreditsFormat.compact(950, locale: locale), "950")
  }

  // MARK: Latest generation

  func testLatestGenerationCarriesThumbnailReference() {
    let snapshot = WidgetSnapshot(
      latestGeneration: .init(mediaID: "m1", title: "Lighthouse", createdAt: referenceDate, thumbnailFileName: "m1.img")
    )
    XCTAssertEqual(
      mapper(snapshot).latestGeneration(),
      .image(mediaID: "m1", title: "Lighthouse", thumbnailFileName: "m1.img", createdAt: referenceDate))
  }

  func testFixtureSnapshotMapsToEveryActiveDisplay() {
    let fixture = WidgetSnapshot.fixture(now: referenceDate)
    let mapper = WidgetEntryMapper(snapshot: fixture, now: referenceDate, locale: locale)
    guard case .active(let count, _, _, _) = mapper.runningAgents() else { return XCTFail("expected active") }
    XCTAssertEqual(count, 2)
    guard case .balance = mapper.credits() else { return XCTFail("expected balance") }
    guard case .image = mapper.latestGeneration() else { return XCTFail("expected image") }
  }
}
