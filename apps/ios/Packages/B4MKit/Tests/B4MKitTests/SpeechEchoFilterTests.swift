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
    Case(
      label: "two reply words merged into one misheard word",
      heard: "the capital of Frans Paris and the capital of Italy is Rome what about Spain",
      expected: "what about Spain",
      spoken: ["The capital of France is Paris, and the capital of Italy is Rome."]),
    Case(
      label: "merged and misheard words before the last word", heard: "the capital for avery lung time", expected: ""),
    Case(
      label: "user word equal to the reply's last word", heard: "sure I can tell you more stop it now",
      expected: "stop it now", spoken: ["Sure.", "I can tell you more about it."]),
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

  // Systematic variants of the full two-chunk reply, each expectation taken from the contract on `SpeechEchoFilter`.
  private static func generatedCases() -> [Case] {
    let reply = "The capital of France is Paris it has been the capital for a very long time"
      .split(separator: " ").map(String.init)
    let last = reply.count - 1
    func text(_ words: [String]) -> String { words.joined(separator: " ") }
    func replaced(_ from: Int, _ count: Int, with words: [String]) -> [String] {
      Array(reply[..<from]) + words + Array(reply[(from + count)...])
    }
    var cases: [Case] = []
    for index in reply.indices {
      let misheard = replaced(index, 1, with: ["zzz"])
      cases.append(
        Case(label: "misheard word \(index)", heard: text(misheard), expected: index == last ? "zzz" : ""))
      cases.append(
        Case(
          label: "misheard word \(index), then user", heard: text(misheard + ["hold", "on"]),
          expected: index == last ? "zzz hold on" : index == last - 1 ? "zzz time hold on" : "hold on"))
      cases.append(
        Case(
          label: "dropped word \(index), then user", heard: text(replaced(index, 1, with: []) + ["hold", "on"]),
          expected: "hold on"))
    }
    for index in 1..<last {
      let misheard = replaced(index, 2, with: ["zzz", "yyy"])
      let trailing = index == last - 1
      cases.append(
        Case(label: "two misheard at \(index)", heard: text(misheard), expected: trailing ? "zzz yyy" : ""))
      cases.append(
        Case(
          label: "two misheard at \(index), then user", heard: text(misheard + ["hold", "on"]),
          expected: trailing ? "zzz yyy hold on" : index == last - 2 ? "zzz yyy time hold on" : "hold on"))
    }
    for index in 0..<last {
      cases.append(
        Case(
          label: "merged words at \(index), then user",
          heard: text(replaced(index, 2, with: ["zzz"]) + ["hold", "on"]),
          expected: index == last - 1 ? "zzz hold on" : index == last - 2 ? "zzz time hold on" : "hold on"))
    }
    for offset in 0..<last - 1 {
      let rest = Array(reply[offset...]) + ["hold", "on"]
      cases.append(Case(label: "starts at \(offset), then user", heard: text(rest), expected: "hold on"))
      cases.append(
        Case(label: "stray word, starts at \(offset), then user", heard: text(["um"] + rest), expected: "hold on"))
    }
    // The user repeats a reply phrase after one or two words of their own, from every place it could start except
    // right where the echo would have continued, which the contract accepts as echo.
    let echo = Array(reply[...5])
    for (lead, continuation) in [(["and"], 6...8), (["what", "about"], 7...8)] {
      for offset in 0..<reply.count - 2 where !continuation.contains(offset) {
        let user = lead + reply[offset...offset + 2]
        cases.append(
          Case(label: "\(text(lead)) + reply phrase at \(offset)", heard: text(echo + user), expected: text(user)))
      }
    }
    for word in ["stop", "wait", "no"] {
      cases.append(Case(label: "one-word barge-in \(word)", heard: word, expected: word))
      cases.append(Case(label: "\(word) after the echo", heard: text(reply + [word]), expected: word))
    }
    return cases
  }

  func testGeneratedVariants() {
    for item in Self.generatedCases() {
      XCTAssertEqual(
        SpeechEchoFilter.residual(recognized: item.heard, spoken: item.spoken, gapTolerance: 2), item.expected,
        item.label)
    }
  }
}
