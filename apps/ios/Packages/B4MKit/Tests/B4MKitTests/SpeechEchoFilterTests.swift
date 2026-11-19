import XCTest

@testable import B4MKit

final class SpeechEchoFilterTests: XCTestCase {
  private static let spoken = ["The capital of France is Paris.", "It has been the capital for a very long time."]
  private static let artReply = ["The capital of France is Paris.", "It is known for art and food."]

  private struct Case {
    let label: String
    let heard: String
    let expected: String
    var spoken: [String] = SpeechEchoFilterTests.spoken
  }

  // Every case the matcher has had to get right lives in one table, so a rule change cannot fix one by breaking another.
  private static let cases: [Case] = [
    Case(label: "exact echo", heard: "the capital of France is Paris", expected: ""),
    Case(label: "exact echo into the next chunk", heard: "The capital of France is Paris it has been", expected: ""),
    Case(
      label: "user after echo", heard: "the capital of France is Paris what about Rome", expected: "what about Rome"),
    Case(label: "misheard and dropped word", heard: "the capitol of France Paris", expected: ""),
    Case(
      label: "misheard word mid-echo, then user",
      heard: "the capital of France is Paris it has bean the capital wait stop", expected: "wait stop"),
    Case(
      label: "misheard word before the reply's last word", heard: "the capital of France is Paris it has bean time",
      expected: ""),
    Case(
      label: "two misheard in a row",
      heard: "the capital of France is Paris it hat bean the capital for a very long time", expected: ""),
    Case(
      label: "two misheard in a row, then user",
      heard: "the capital of France is Paris it hat bean the capital for a very long time hold on", expected: "hold on"),
    Case(
      label: "two misheard early, then user",
      heard: "the capitol of Frank us Paris it has been the capital for a very long time hold on", expected: "hold on"),
    Case(
      label: "recognizer starts mid-reply", heard: "been the capital for a very long time hold on", expected: "hold on"),
    Case(label: "stray leading word", heard: "um the capital of France is Paris", expected: ""),
    Case(
      label: "misheard leading word", heard: "a capital of France is Paris what about Rome", expected: "what about Rome"
    ),
    Case(
      label: "two stray leading words", heard: "so so the capital of France is Paris",
      expected: "so so the capital of France is Paris"),
    Case(label: "stray word then one echo word", heard: "wait Paris", expected: "wait Paris"),
    Case(
      label: "stray word then last reply word", heard: "so time what about Rome", expected: "so time what about Rome"),
    Case(label: "reply's last word alone", heard: "time what about Rome", expected: "what about Rome"),
    Case(
      label: "one-chunk reply's last word alone", heard: "Paris what about Rome", expected: "what about Rome",
      spoken: ["The capital of France is Paris."]),
    Case(label: "not the reply", heard: "wait stop that", expected: "wait stop that"),
    Case(label: "not the reply, shares a word", heard: "the weather today", expected: "the weather today"),
    Case(
      label: "user repeats reply words after a break",
      heard: "the capital of France is Paris what about the capital of Italy",
      expected: "what about the capital of Italy"),
    Case(label: "early reply word then user", heard: "Paris what about it", expected: "Paris what about it"),
    Case(
      label: "question reusing reply words", heard: "what is the capital of Italy",
      expected: "what is the capital of Italy"),
    Case(
      label: "question reusing a chunk already passed", heard: "the capital of Italy", expected: "the capital of Italy",
      spoken: artReply),
    Case(
      label: "question reusing the chunk now playing", heard: "the capital of Italy", expected: "Italy",
      spoken: [artReply[0]]),
    Case(
      label: "user question right after an echo, reusing reply words",
      heard: "the capital of France what is the capital of Spain", expected: "what is the capital of Spain"),
    Case(
      label: "one-word interjection, then a phrase from later in the reply",
      heard: "the capital of France is Paris and the capital of Spain", expected: "and the capital of Spain"),
    Case(label: "empty transcript", heard: "", expected: ""),
    Case(label: "nothing spoken", heard: "hello there", expected: "hello there", spoken: []),
    Case(label: "blank chunks", heard: "hello there", expected: "hello there", spoken: ["", "  "]),
  ]

  func testEveryCase() {
    for item in Self.cases {
      XCTAssertEqual(
        SpeechEchoFilter.residual(recognized: item.heard, spoken: item.spoken, gapTolerance: 2), item.expected,
        item.label)
    }
  }
}
