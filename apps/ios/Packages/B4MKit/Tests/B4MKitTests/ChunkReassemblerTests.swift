import XCTest

@testable import B4MKit

final class ChunkReassemblerTests: XCTestCase {
  private let start = Date(timeIntervalSince1970: 1_800_000_000)

  private func chunk(_ id: String, _ index: Int, of total: Int, _ data: String) -> FrameChunk {
    FrameChunk(chunkID: id, index: index, total: total, data: data)
  }

  func testPiecesInAnyOrderReassembleInIndexOrder() {
    var reassembler = ChunkReassembler()
    XCTAssertEqual(reassembler.accept(chunk("a", 2, of: 3, "\"}"), at: start), .pending)
    XCTAssertEqual(reassembler.accept(chunk("a", 0, of: 3, "{\"k\":"), at: start), .pending)
    XCTAssertEqual(reassembler.accept(chunk("a", 1, of: 3, "\"v"), at: start), .complete("{\"k\":\"v\"}"))
    XCTAssertEqual(reassembler.pendingCount, 0)
  }

  func testInterleavedChunkIDsStaySeparate() {
    var reassembler = ChunkReassembler()
    _ = reassembler.accept(chunk("a", 0, of: 2, "A0"), at: start)
    _ = reassembler.accept(chunk("b", 0, of: 2, "B0"), at: start)
    XCTAssertEqual(reassembler.accept(chunk("b", 1, of: 2, "B1"), at: start), .complete("B0B1"))
    XCTAssertEqual(reassembler.accept(chunk("a", 1, of: 2, "A1"), at: start), .complete("A0A1"))
  }

  func testMissingPieceExpiresAfterTheTTLAndALateStragglerCannotCompleteIt() {
    var reassembler = ChunkReassembler()
    _ = reassembler.accept(chunk("a", 0, of: 3, "x"), at: start)
    _ = reassembler.accept(chunk("a", 2, of: 3, "z"), at: start)

    reassembler.purgeExpired(at: start.addingTimeInterval(29))
    XCTAssertEqual(reassembler.pendingCount, 1, "still inside the TTL")

    reassembler.purgeExpired(at: start.addingTimeInterval(30))
    XCTAssertEqual(reassembler.pendingCount, 0, "dropped at the TTL")

    let late = reassembler.accept(chunk("a", 1, of: 3, "y"), at: start.addingTimeInterval(31))
    XCTAssertEqual(late, .pending, "the straggler starts over instead of completing garbage")
  }

  func testOtherTrafficPurgesExpiredPartials() {
    var reassembler = ChunkReassembler()
    _ = reassembler.accept(chunk("a", 0, of: 2, "x"), at: start)
    XCTAssertEqual(reassembler.accept(chunk("b", 0, of: 1, "{}"), at: start.addingTimeInterval(45)), .complete("{}"))
    XCTAssertEqual(reassembler.pendingCount, 0)
  }

  func testMoreThan256PartsIsDropped() {
    var reassembler = ChunkReassembler()
    XCTAssertEqual(reassembler.accept(chunk("big", 0, of: 257, "x"), at: start), .dropped(.tooManyParts))
    XCTAssertEqual(reassembler.pendingCount, 0)
    XCTAssertEqual(reassembler.accept(chunk("ok", 0, of: 256, "x"), at: start), .pending, "256 is the limit, inclusive")
  }

  func testInconsistentTotalDropsThePartial() {
    var reassembler = ChunkReassembler()
    _ = reassembler.accept(chunk("a", 0, of: 3, "x"), at: start)
    XCTAssertEqual(reassembler.accept(chunk("a", 1, of: 4, "y"), at: start), .dropped(.inconsistentTotal))
    XCTAssertEqual(reassembler.pendingCount, 0)
  }

  func testOpenPartialsAreBounded() {
    var reassembler = ChunkReassembler()
    for index in 0..<(ChunkReassembler.maxPartials + 10) {
      _ = reassembler.accept(chunk("p\(index)", 0, of: 2, "x"), at: start.addingTimeInterval(Double(index) / 100))
    }
    XCTAssertEqual(reassembler.pendingCount, ChunkReassembler.maxPartials)
  }
}

final class InboundFrameTests: XCTestCase {
  func testBarePongAndJSONPong() {
    XCTAssertEqual(InboundFrame.parse("pong"), .pong)
    XCTAssertEqual(InboundFrame.parse(" pong\n"), .pong)
    XCTAssertEqual(InboundFrame.parse("{\"action\":\"pong\"}"), .pong)
  }

  func testJunkIsIgnored() {
    for text in ["", "\n", "hello", "[]", "null", "true", "{}", "{\"action\":null}"] {
      XCTAssertEqual(InboundFrame.parse(text), .ignored, text)
    }
  }

  func testChunkFramesAreRecognizedWithoutAnAction() {
    let frame = InboundFrame.parse(
      #"{"_chunked":true,"_chunkId":"c","_chunkIndex":1,"_totalChunks":2,"_data":"{\"a\":"}"#)
    XCTAssertEqual(frame, .chunk(FrameChunk(chunkID: "c", index: 1, total: 2, data: "{\"a\":")))
  }

  func testMalformedChunksAreIgnored() {
    XCTAssertEqual(
      InboundFrame.parse(#"{"_chunked":true,"_chunkId":"c","_chunkIndex":2,"_totalChunks":2,"_data":""}"#), .ignored)
    XCTAssertEqual(
      InboundFrame.parse(#"{"_chunked":true,"_chunkId":"","_chunkIndex":0,"_totalChunks":1,"_data":""}"#), .ignored)
    XCTAssertEqual(
      InboundFrame.parse(#"{"_chunked":true,"_chunkId":"c","_chunkIndex":0.5,"_totalChunks":1,"_data":""}"#),
      .ignored)
  }

  func testUnknownActionIsAnActionFrame() {
    XCTAssertEqual(
      InboundFrame.parse(#"{"action":"brand_new","x":1}"#),
      .action(ActionFrame(action: "brand_new", payload: ["action": "brand_new", "x": 1])))
  }

  func testOutboundFramesMatchTheServerSchemas() {
    XCTAssertEqual(OutboundFrame.heartbeat.text, #"{"action":"heartbeat"}"#)
    XCTAssertEqual(
      OutboundFrame.reauthenticate(accessToken: "a.b.c").text, #"{"accessToken":"a.b.c","action":"reauth_connection"}"#)
    XCTAssertEqual(
      OutboundFrame.unsubscribe(subscriptionID: "s").text, #"{"action":"unsubscribe_query","subscriptionId":"s"}"#)
  }
}
