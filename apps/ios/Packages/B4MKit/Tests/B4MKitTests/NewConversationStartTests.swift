import XCTest

@testable import B4MKit

final class NewConversationStartTests: XCTestCase {
  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  private func date(hour: Int) -> Date {
    calendar.date(from: DateComponents(year: 2026, month: 1, day: 5, hour: hour, minute: 30))!
  }

  func testSalutationBucketsByHour() {
    let expectations: [(Int, String)] = [
      (0, "Good evening"), (4, "Good evening"), (5, "Good morning"), (11, "Good morning"),
      (12, "Good afternoon"), (17, "Good afternoon"), (18, "Good evening"), (23, "Good evening"),
    ]
    for (hour, expected) in expectations {
      XCTAssertEqual(StartGreeting.salutation(at: date(hour: hour), calendar: calendar), expected, "hour \(hour)")
    }
  }

  func testHeadlineAppendsTheFirstNameWhenKnown() {
    XCTAssertEqual(
      StartGreeting.headline(at: date(hour: 9), firstName: "Alex", calendar: calendar), "Good morning, Alex")
  }

  func testHeadlineFallsBackToTheBareSalutation() {
    XCTAssertEqual(StartGreeting.headline(at: date(hour: 9), firstName: nil, calendar: calendar), "Good morning")
    XCTAssertEqual(StartGreeting.headline(at: date(hour: 9), firstName: "  ", calendar: calendar), "Good morning")
  }

  func testChipPrefills() {
    XCTAssertEqual(StarterChip.write.prefill, "Help me write ")
    XCTAssertEqual(StarterChip.brainstorm.prefill, "Brainstorm ideas for ")
    XCTAssertEqual(StarterChip.explainCode.prefill, "Explain this code: ")
    XCTAssertNil(StarterChip.voiceNote.prefill)
    XCTAssertEqual(StarterChip.allCases.count, 4)
  }

  func testFirstNameComesFromGivenNameThenFirstWordOfName() {
    func jwt(_ claims: [String: Any]) -> String {
      let payload = Base64URL.encode(try! JSONSerialization.data(withJSONObject: claims))
      return "e30.\(payload).sig"
    }
    XCTAssertEqual(AccessToken.firstName(ofJWT: jwt(["given_name": "Sam", "name": "Pat Doe"])), "Sam")
    XCTAssertEqual(AccessToken.firstName(ofJWT: jwt(["name": "Pat Doe"])), "Pat")
    XCTAssertNil(AccessToken.firstName(ofJWT: jwt(["sub": "user-1"])))
    XCTAssertNil(AccessToken.firstName(ofJWT: "not-a-jwt"))
  }
}
