import XCTest

@testable import B4MKit

private actor FakeBriefScheduleAPI: BriefScheduleAPI {
  var stored: BriefSchedule?
  var failSaves = false
  private(set) var saved: [BriefSchedule] = []

  init(stored: BriefSchedule? = nil) { self.stored = stored }

  func setFailSaves(_ fail: Bool) { failSaves = fail }

  func schedule() async throws -> BriefSchedule? { stored }

  func save(_ schedule: BriefSchedule) async throws -> BriefSchedule {
    saved.append(schedule)
    if failSaves { throw APIError.server(status: 500) }
    stored = schedule
    return schedule
  }
}

private actor HeldBriefScheduleAPI: BriefScheduleAPI {
  private(set) var stored = BriefSchedule.defaults(timeZone: "Asia/Kolkata")
  private(set) var saved: [BriefSchedule] = []
  private var pending: CheckedContinuation<BriefSchedule, any Error>?
  private var waiting: (count: Int, continuation: CheckedContinuation<Void, Never>)?

  func schedule() async throws -> BriefSchedule? { stored }

  func save(_ schedule: BriefSchedule) async throws -> BriefSchedule {
    saved.append(schedule)
    if pending != nil {
      stored = schedule
      return schedule
    }
    return try await withCheckedThrowingContinuation { continuation in
      pending = continuation
      if let waiting, saved.count >= waiting.count {
        self.waiting = nil
        waiting.continuation.resume()
      }
    }
  }

  func waitForSave(_ count: Int) async {
    if saved.count >= count { return }
    await withCheckedContinuation { waiting = (count, $0) }
  }

  func finish(success: Bool) {
    let continuation = pending
    pending = nil
    if success {
      stored = saved.last!
      continuation?.resume(returning: stored)
    } else {
      continuation?.resume(throwing: APIError.server(status: 500))
    }
  }
}

@MainActor
final class BriefScheduleViewModelTests: XCTestCase {
  private func model(_ api: any BriefScheduleAPI, zone: String = "Asia/Kolkata") -> BriefScheduleViewModel {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: zone)!
    calendar.locale = Locale(identifier: "en_US")
    return BriefScheduleViewModel(api: api, calendar: calendar, currentTimeZone: { TimeZone(identifier: zone)! })
  }

  func testANeverSavedScheduleLoadsAsWeekdayMorningsOff() async {
    let vm = model(FakeBriefScheduleAPI())
    await vm.load()
    XCTAssertTrue(vm.isLoaded)
    XCTAssertEqual(
      vm.schedule,
      BriefSchedule(enabled: false, timeOfDay: "08:00", days: [1, 2, 3, 4, 5], timeZone: "Asia/Kolkata")
    )
  }

  func testEverySaveStampsTheDeviceTimeZone() async {
    let api = FakeBriefScheduleAPI(
      stored: BriefSchedule(enabled: false, timeOfDay: "08:00", days: [1], timeZone: "Europe/Paris")
    )
    let vm = model(api, zone: "America/New_York")
    await vm.load()
    await vm.setEnabled(true)
    let sent = await api.saved
    XCTAssertEqual(sent.last?.timeZone, "America/New_York")
    XCTAssertEqual(sent.last?.enabled, true)
  }

  func testAFailedSaveRollsBackAndExplains() async {
    let api = FakeBriefScheduleAPI()
    await api.setFailSaves(true)
    let vm = model(api)
    await vm.load()
    await vm.setEnabled(true)
    XCTAssertFalse(vm.schedule.enabled)
    XCTAssertNotNil(vm.errorMessage)
  }

  func testSetTimeWritesTwentyFourHourWallClock() async {
    let api = FakeBriefScheduleAPI()
    let vm = model(api)
    await vm.load()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Kolkata")!
    let evening = calendar.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 18, minute: 5))!
    await vm.setTime(evening)
    XCTAssertEqual(vm.schedule.timeOfDay, "18:05")
    XCTAssertEqual(vm.schedule.hourAndMinute?.hour, 18)
  }

  func testWeekdaysUseServerNumberingStartingOnTheLocalesFirstDay() async {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = Locale(identifier: "en_GB")
    calendar.firstWeekday = 2
    let vm = BriefScheduleViewModel(
      api: FakeBriefScheduleAPI(), calendar: calendar, currentTimeZone: { TimeZone(identifier: "UTC")! })
    XCTAssertEqual(vm.weekdays.map(\.id), [1, 2, 3, 4, 5, 6, 0])
    XCTAssertEqual(vm.weekdays.first?.shortName, "M")
  }

  func testTogglingADayAddsAndRemovesIt() async {
    let api = FakeBriefScheduleAPI()
    let vm = model(api)
    await vm.load()
    await vm.toggleDay(6)
    XCTAssertEqual(vm.schedule.days, [1, 2, 3, 4, 5, 6])
    await vm.toggleDay(1)
    XCTAssertEqual(vm.schedule.days, [2, 3, 4, 5, 6])
  }

  func testTheLastDayCannotBeRemoved() async {
    let api = FakeBriefScheduleAPI(
      stored: BriefSchedule(enabled: true, timeOfDay: "08:00", days: [3], timeZone: "Asia/Kolkata")
    )
    let vm = model(api)
    await vm.load()
    await vm.toggleDay(3)
    XCTAssertEqual(vm.schedule.days, [3])
    XCTAssertNotNil(vm.errorMessage)
    let sent = await api.saved
    XCTAssertTrue(sent.isEmpty)
  }

  func testPendingSaveBlocksAllEditsUntilTheStoredScheduleSettles() async {
    let api = HeldBriefScheduleAPI()
    let vm = model(api)
    await vm.load()
    let first = Task { await vm.setEnabled(true) }
    await api.waitForSave(1)
    XCTAssertTrue(vm.isSaving)

    await vm.setEnabled(false)
    await vm.setTime(Date())
    await vm.toggleDay(6)
    let sent = await api.saved
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(vm.schedule, sent[0])
    await api.finish(success: true)
    await first.value
    XCTAssertFalse(vm.isSaving)
    let stored = await api.stored
    XCTAssertEqual(vm.schedule, stored)
    XCTAssertTrue(stored.enabled)

    let second = Task { await vm.setEnabled(false) }
    await api.waitForSave(2)
    await api.finish(success: true)
    await second.value
    let finalStored = await api.stored
    XCTAssertEqual(vm.schedule, finalStored)
    XCTAssertFalse(finalStored.enabled)
  }

  func testPendingABAEditsCannotOwnTheFirstFailureOrLeaveAStaleErrorAfterRetry() async {
    let api = HeldBriefScheduleAPI()
    let vm = model(api)
    await vm.load()
    let original = vm.schedule
    let first = Task { await vm.setEnabled(true) }
    await api.waitForSave(1)
    await vm.setEnabled(false)
    await vm.setEnabled(true)
    await api.finish(success: false)
    await first.value

    let sent = await api.saved
    let stored = await api.stored
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(vm.schedule, original)
    XCTAssertEqual(stored, original)
    XCTAssertNotNil(vm.errorMessage)
    XCTAssertFalse(vm.isSaving)

    let retry = Task { await vm.setEnabled(true) }
    await api.waitForSave(2)
    XCTAssertNil(vm.errorMessage)
    await api.finish(success: true)
    await retry.value
    let finalStored = await api.stored
    XCTAssertEqual(vm.schedule, finalStored)
    XCTAssertTrue(finalStored.enabled)
    XCTAssertNil(vm.errorMessage)
  }
}
