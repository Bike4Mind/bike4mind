import XCTest

@testable import B4MKit

final class LineageTests: XCTestCase {
  private let body = Data(
    """
    {"file_id":"v1","truncated":false,
     "ancestors":[
       {"file_id":"v1","depth":0,"redacted":false,"file_name":"clip.mp4","mime_type":"video/mp4","generator":"video",
        "model_id":"veo-3","prompt":"a fox","download_url":"https://cdn/v1","created_at":"2026-01-01T00:00:00.000Z",
        "request":{"durationSeconds":6,"aspectRatio":"16:9","resolution":"720p","audio":true}},
       {"file_id":"i1","depth":1,"redacted":false,"file_name":"fox.png","mime_type":"image/png","generator":"image",
        "model_id":"gpt-image","prompt":"a fox","download_url":"https://cdn/i1","created_at":"2026-01-01T00:00:00.000Z","request":null},
       {"file_id":"x9","depth":1,"redacted":true,"file_name":null,"mime_type":null,"generator":null,"model_id":null,
        "prompt":null,"download_url":null,"created_at":null,"request":null}],
     "children":[
       {"file_id":"v2","depth":-1,"redacted":false,"file_name":"b.mp4","mime_type":"video/mp4","generator":"video",
        "model_id":null,"prompt":null,"download_url":null,"created_at":null,"request":null}],
     "edges":[
       {"parent_id":"i1","child_id":"v1","role":"first_frame"},
       {"parent_id":"x9","child_id":"v1","role":"brand_new_role"},
       {"parent_id":"v1","child_id":"v2","role":"extend_of"}]}
    """.utf8)

  func testDecodesTrailAndSplitsMadeFromAndInto() throws {
    let lineage = try MediaWire.lineage(status: 200, body: body)
    XCTAssertEqual(lineage.madeFrom.map(\.node.id), ["i1", "x9"])
    XCTAssertEqual(lineage.madeInto.map(\.node.id), ["v2"])
    XCTAssertEqual(lineage.madeInto.first?.role, .extendOf)
    XCTAssertTrue(lineage.madeFrom[1].node.isRedacted)
    XCTAssertNil(lineage.madeFrom[1].node.mediaItem)
  }

  func testUnknownRoleSurvivesAsGeneric() throws {
    let lineage = try MediaWire.lineage(status: 200, body: body)
    XCTAssertEqual(lineage.madeFrom[1].role, .other("brand_new_role"))
    XCTAssertEqual(lineage.madeFrom[1].role.title, "Made from")
  }

  func testNonOKStatusThrows() {
    XCTAssertThrowsError(try MediaWire.lineage(status: 404, body: Data()))
  }

  func testBranchSeedCarriesModelPromptParamsAndFrames() throws {
    let lineage = try MediaWire.lineage(status: 200, body: body)
    let seed = try XCTUnwrap(LineageBranch.seed(for: XCTUnwrap(lineage.root), parents: lineage.madeFrom))
    XCTAssertEqual(seed.kind, .video)
    XCTAssertEqual(seed.modelID, "veo-3")
    XCTAssertEqual(seed.prompt, "a fox")
    XCTAssertEqual(seed.params[.duration], .number(6))
    XCTAssertEqual(seed.params[.aspectRatio], .text("16:9"))
    XCTAssertEqual(seed.params[.audio], .flag(true))
    XCTAssertEqual(seed.inputs.map(\.role), [.firstFrame])
    XCTAssertEqual(seed.inputs.first?.item.id, "i1")
  }

  func testBranchIsNilForAFileThatWasNotGenerated() {
    let upload = LineageNode(id: "u", kind: .image, fileName: "a.png", mimeType: "image/png")
    XCTAssertNil(LineageBranch.seed(for: upload, parents: []))
  }

  @MainActor
  func testViewModelLoadsAndTreatsFailureAsNoChips() async {
    struct Failing: MediaAPI {
      func listMedia(kind: MediaKind?, page: Int, limit: Int) async throws -> MediaPage {
        MediaPage(items: [], hasMore: false)
      }
      func media(id: String) async throws -> MediaItem { throw APIError.notFound }
      func lineage(of id: String) async throws -> FileLineage { throw APIError.notFound }
    }
    let model = LineageViewModel(fileID: "v1", api: Failing())
    await model.load()
    XCTAssertEqual(model.state, .failed)
    XCTAssertNil(model.lineage)
  }
}
