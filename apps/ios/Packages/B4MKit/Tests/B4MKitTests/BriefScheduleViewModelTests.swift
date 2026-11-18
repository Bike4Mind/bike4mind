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

@MainActor
final class BriefScheduleViewModelTests: XCTestCase {
  private func model(_ api: FakeBriefScheduleAPI, zone: String = "Asia/Kolkata") -> BriefScheduleViewModel {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: zone)!
    calendar.locale = Locale(identifier: "en_US")
    return BriefScheduleViewModel(api: api, calendar: calendar, currentTimeZone: { TimeZone(identifier: zone)! })
  }

  func testANeverSavedScheduleLoadsAsWeekdayMorningsOff() async {
    let vm = model(FakeBriefScheduleAPI())
    await vm.load()
    XCTAssertTrue(vm.isLoaded)
    XCTAssertEqual(vm.schedule, BriefSchedule(enabled: false, timeOfDay: "08:00", days: [1, 2, 3, 4, 5], timeZone: "Asia/Kolkata"))
  }

  func testEverySaveStampsTheDeviceTimeZone() async {
    let api = FakeBriefScheduleAPI(stored: BriefSchedule(enabled: false, timeOfDay: "08:00", days: [1], timeZone: "Europe/Paris"))
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
    let api = FakeBriefScheduleAPI(stored: BriefSchedule(enabled: true, timeOfDay: "08:00", days: [3], timeZone: "Asia/Kolkata"))
    let vm = model(api)
    await vm.load()
    await vm.toggleDay(3)
    XCTAssertEqual(vm.schedule.days, [3])
    XCTAssertNotNil(vm.errorMessage)
    let sent = await api.saved
    XCTAssertTrue(sent.isEmpty)
  }
}
