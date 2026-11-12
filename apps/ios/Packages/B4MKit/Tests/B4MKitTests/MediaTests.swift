import AVFoundation
import ImageIO
import XCTest

@testable import B4MKit

private let base = URL(string: "https://app.example.test")!

private func fileJSON(
  id: String = "f1", name: String = "lighthouse.png", mime: String = "image/png",
  url: String? = "https://s3.example/f1?sig=1",
  expires: String? = "2026-11-02T12:00:00.000Z", created: String = "2026-11-02T10:30:00.000Z"
) -> [String: Any] {
  var file: [String: Any] = ["id": id, "fileName": name, "mimeType": mime, "fileSize": 2048, "createdAt": created]
  if let url { file["fileUrl"] = url }
  if let expires { file["fileUrlExpireAt"] = expires }
  return file
}

private func listBody(_ files: [[String: Any]], hasMore: Bool = false) throws -> Data {
  try JSONSerialization.data(withJSONObject: ["data": files, "hasMore": hasMore, "total": files.count])
}

final class MediaClientTests: XCTestCase {
  private func components(_ request: URLRequest) throws -> URLComponents {
    try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
  }

  func testListRequestsGeneratedFilesNewestFirstWithBearer() async throws {
    let body = try listBody([])
    let transport = FakeTransport { _ in (200, body) }
    let client = MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    _ = try await client.listMedia(kind: .video, page: 3, limit: 30)

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/files")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    let query = Dictionary(
      uniqueKeysWithValues: try (components(request).queryItems ?? []).map { ($0.name, $0.value ?? "") })
    XCTAssertEqual(query["filters[generated]"], "true")
    XCTAssertEqual(query["filters[type]"], "video")
    XCTAssertEqual(query["pagination[page]"], "3")
    XCTAssertEqual(query["pagination[limit]"], "30")
    XCTAssertEqual(query["order[by]"], "createdAt")
    XCTAssertEqual(query["order[direction]"], "desc")
    XCTAssertEqual(query["options[excludeContent]"], "true")
  }

  func testUnfilteredListOmitsTheTypeFilter() async throws {
    let body = try listBody([])
    let transport = FakeTransport { _ in (200, body) }
    let client = MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    _ = try await client.listMedia(kind: nil, page: 1, limit: 10)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertFalse(try components(request).queryItems?.contains { $0.name == "filters[type]" } ?? true)
  }

  func testListMapsRowsAndDropsWhatTheGalleryCannotDraw() async throws {
    let rows = [
      fileJSON(id: "a"), fileJSON(id: "b", name: "clip.mp4", mime: "video/mp4"),
      fileJSON(id: "c", name: "song.mp3", mime: "audio/mpeg"),
      fileJSON(id: "d", name: "notes.pdf", mime: "application/pdf"),
      ["fileName": "no-id.png", "mimeType": "image/png"],
    ]
    let body = try listBody(rows, hasMore: true)
    let transport = FakeTransport { _ in (200, body) }
    let page = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
      .listMedia(kind: nil, page: 1, limit: 30)

    XCTAssertEqual(page.items.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(page.items.map(\.kind), [.image, .video, .audio])
    XCTAssertTrue(page.hasMore)
    let first = page.items[0]
    XCTAssertEqual(first.fileName, "lighthouse.png")
    XCTAssertEqual(first.url, URL(string: "https://s3.example/f1?sig=1"))
    XCTAssertEqual(first.fileSize, 2048)
    XCTAssertEqual(first.createdAt, Date(timeIntervalSince1970: 1_793_615_400))
    XCTAssertEqual(first.urlExpiresAt, Date(timeIntervalSince1970: 1_793_620_800))
  }

  func testMongoStyleUnderscoreIdIsAccepted() async throws {
    var row = fileJSON()
    row["id"] = nil
    row["_id"] = "mongo-1"
    let body = try listBody([row])
    let transport = FakeTransport { _ in (200, body) }
    let page = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
      .listMedia(kind: nil, page: 1, limit: 30)
    XCTAssertEqual(page.items.map(\.id), ["mongo-1"])
  }

  func testDatesWithoutFractionalSecondsParse() async throws {
    let body = try listBody([fileJSON(created: "2026-11-02T10:30:00Z")])
    let transport = FakeTransport { _ in (200, body) }
    let page = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
      .listMedia(kind: nil, page: 1, limit: 30)
    XCTAssertEqual(page.items.first?.createdAt, Date(timeIntervalSince1970: 1_793_615_400))
  }

  func testWithheldUrlLeavesTheItemWithoutOne() async throws {
    // A file still held for scanning comes back as a record with no fileUrl.
    let body = try listBody([fileJSON(url: nil, expires: nil)])
    let transport = FakeTransport { _ in (200, body) }
    let page = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
      .listMedia(kind: nil, page: 1, limit: 30)
    XCTAssertNil(page.items.first?.url)
    XCTAssertFalse(try XCTUnwrap(page.items.first).isURLUsable(at: .now))
  }

  func testDetailFetchesOneFileById() async throws {
    let body = try JSONSerialization.data(withJSONObject: fileJSON(id: "f9"))
    let transport = FakeTransport { _ in (200, body) }
    let item = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport).media(id: "f9")
    XCTAssertEqual(item.id, "f9")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/files/f9")
  }

  func testDetailRejectsIdsThatCouldRewriteThePath() async {
    let transport = FakeTransport { _ in (200, Data()) }
    let client = MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    for id in ["", "../admin", "a/b", "a?b=1"] {
      do {
        _ = try await client.media(id: id)
        XCTFail("expected \(id) to be refused")
      } catch {
        XCTAssertEqual(error as? APIError, .notFound)
      }
    }
    let sent = await transport.requests
    XCTAssertTrue(sent.isEmpty)
  }

  func testDetailOfADocumentIsMalformed() async throws {
    let body = try JSONSerialization.data(withJSONObject: fileJSON(mime: "application/pdf"))
    let transport = FakeTransport { _ in (200, body) }
    do {
      _ = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport).media(id: "f1")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testStatusesFoldIntoAPIError() async {
    for (status, expected) in [
      (404, APIError.notFound), (403, .forbidden), (429, .rateLimited), (500, .server(status: 500)),
    ] {
      let transport = FakeTransport { _ in (status, Data()) }
      do {
        _ = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
          .listMedia(kind: nil, page: 1, limit: 30)
        XCTFail("expected failure for \(status)")
      } catch {
        XCTAssertEqual(error as? APIError, expected)
      }
    }
  }

  func testGarbageBodyIsMalformed() async {
    let transport = FakeTransport { _ in (200, Data("<html>".utf8)) }
    do {
      _ = try await MediaClient(baseURL: base, tokens: FakeTokens(), transport: transport)
        .listMedia(kind: nil, page: 1, limit: 30)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testA401RefreshesTheTokenOnceAndRetriesWithTheQuery() async throws {
    let body = try listBody([])
    let transport = FakeTransport { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1" ? (401, Data()) : (200, body)
    }
    let tokens = FakeTokens()
    _ = try await MediaClient(baseURL: base, tokens: tokens, transport: transport).listMedia(
      kind: .image, page: 1, limit: 5)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertTrue(
      requests[1].url?.query()?.contains("filters%5Btype%5D=image") == true
        || requests[1].url?.query()?.contains("filters[type]=image") == true)
    let invalidations = await tokens.invalidations
    XCTAssertEqual(invalidations, 1)
  }
}

final class MediaItemTests: XCTestCase {
  private func item(expires: Date?, url: URL? = URL(string: "https://s3.example/x")) -> MediaItem {
    MediaItem(
      id: "1", kind: .image, fileName: "a.png", mimeType: "image/png", createdAt: referenceDate, url: url,
      urlExpiresAt: expires)
  }

  func testUrlIsUsableUntilTheExpiryMargin() {
    let expires = referenceDate.addingTimeInterval(600)
    XCTAssertTrue(item(expires: expires).isURLUsable(at: referenceDate))
    XCTAssertTrue(item(expires: expires).isURLUsable(at: expires.addingTimeInterval(-MediaItem.expiryMargin - 1)))
    XCTAssertFalse(item(expires: expires).isURLUsable(at: expires.addingTimeInterval(-MediaItem.expiryMargin)))
    XCTAssertFalse(item(expires: expires).isURLUsable(at: expires.addingTimeInterval(1)))
  }

  func testUrlWithoutKnownExpiryIsTrustedAndMissingUrlNever() {
    XCTAssertTrue(item(expires: nil).isURLUsable(at: referenceDate))
    XCTAssertFalse(item(expires: nil, url: nil).isURLUsable(at: referenceDate))
  }

  func testMimeTypesMapToKinds() {
    XCTAssertEqual(MediaKind(mimeType: "IMAGE/JPEG"), .image)
    XCTAssertEqual(MediaKind(mimeType: "video/quicktime"), .video)
    XCTAssertEqual(MediaKind(mimeType: "audio/wav"), .audio)
    XCTAssertNil(MediaKind(mimeType: "text/plain"))
    XCTAssertNil(MediaKind(mimeType: ""))
  }

  func testDisplayTitleDropsTheExtension() {
    XCTAssertEqual(item(expires: nil).displayTitle, "a")
  }
}

actor FakeMediaAPI: MediaAPI {
  var pages: [Int: MediaPage] = [:]
  var detail: [MediaItem] = []
  var failure: APIError?
  private(set) var listCalls: [(kind: MediaKind?, page: Int)] = []
  private(set) var detailCalls = 0
  private var gate: CheckedContinuation<Void, Never>?
  private var holdKind: MediaKind??

  func setPages(_ pages: [Int: MediaPage]) { self.pages = pages }
  func setDetail(_ detail: [MediaItem]) { self.detail = detail }
  func setFailure(_ failure: APIError?) { self.failure = failure }
  /// Parks listings for `kind` until `release()`, to let a test change filters mid-flight.
  func hold(kind: MediaKind?) { holdKind = .some(kind) }

  func release() {
    holdKind = nil
    gate?.resume()
    gate = nil
  }

  func listMedia(kind: MediaKind?, page: Int, limit: Int) async throws -> MediaPage {
    listCalls.append((kind, page))
    if case .some(let held) = holdKind, held == kind { await withCheckedContinuation { gate = $0 } }
    if let failure { throw failure }
    return pages[page] ?? MediaPage(items: [], hasMore: false)
  }

  func media(id: String) async throws -> MediaItem {
    detailCalls += 1
    if let failure { throw failure }
    return detail[min(detailCalls - 1, detail.count - 1)]
  }
}

private func image(_ id: String, expires: Date? = nil) -> MediaItem {
  MediaItem(
    id: id, kind: .image, fileName: "\(id).png", mimeType: "image/png", createdAt: referenceDate,
    url: URL(string: "https://s3.example/\(id)"), urlExpiresAt: expires)
}

private actor Collector {
  private(set) var ids: [String] = []
  func add(_ id: String) { ids.append(id) }
}

@MainActor
final class MediaGalleryViewModelTests: XCTestCase {
  func testLoadFetchesTheFirstPage() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [image("a"), image("b")], hasMore: false)])
    let model = MediaGalleryViewModel(api: api)
    await model.load()
    XCTAssertEqual(model.items.map(\.id), ["a", "b"])
    XCTAssertEqual(model.state, .loaded)
    XCTAssertFalse(model.canLoadMore)
  }

  func testLoadIsANoOpOnceLoaded() async {
    let api = FakeMediaAPI()
    let model = MediaGalleryViewModel(api: api)
    await model.load()
    await model.load()
    let calls = await api.listCalls
    XCTAssertEqual(calls.count, 1)
  }

  func testPagingAppendsAndDeduplicatesAcrossPages() async {
    let api = FakeMediaAPI()
    await api.setPages([
      1: MediaPage(items: [image("a"), image("b")], hasMore: true),
      2: MediaPage(items: [image("b"), image("c")], hasMore: false),
    ])
    let model = MediaGalleryViewModel(api: api, pageSize: 2)
    await model.load()
    XCTAssertTrue(model.canLoadMore)
    await model.loadMore()
    XCTAssertEqual(model.items.map(\.id), ["a", "b", "c"])
    XCTAssertFalse(model.canLoadMore)
    await model.loadMore()
    let calls = await api.listCalls
    XCTAssertEqual(calls.map(\.page), [1, 2])
  }

  func testLoadMoreFiresOnlyNearTheEnd() async {
    let api = FakeMediaAPI()
    let first = (0..<20).map { image("m\($0)") }
    await api.setPages([1: MediaPage(items: first, hasMore: true), 2: MediaPage(items: [image("z")], hasMore: false)])
    let model = MediaGalleryViewModel(api: api, pageSize: 20)
    await model.load()
    await model.loadMoreIfNeeded(currentItem: first[0])
    var calls = await api.listCalls
    XCTAssertEqual(calls.count, 1)
    await model.loadMoreIfNeeded(currentItem: first[19])
    calls = await api.listCalls
    XCTAssertEqual(calls.count, 2)
  }

  func testFailedFirstLoadReportsTheError() async {
    let api = FakeMediaAPI()
    await api.setFailure(.offline)
    let model = MediaGalleryViewModel(api: api)
    await model.load()
    XCTAssertEqual(model.state, .failed(.offline))
    XCTAssertTrue(model.items.isEmpty)
  }

  func testFailedRefreshKeepsRowsOnScreen() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [image("a")], hasMore: false)])
    let model = MediaGalleryViewModel(api: api)
    await model.load()
    await api.setFailure(.offline)
    await model.refresh()
    XCTAssertEqual(model.items.map(\.id), ["a"])
    XCTAssertEqual(model.state, .failed(.offline))
  }

  func testFailedLoadMoreIsReportedApartFromTheList() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [image("a")], hasMore: true)])
    let model = MediaGalleryViewModel(api: api)
    await model.load()
    await api.setFailure(.rateLimited)
    await model.loadMore()
    XCTAssertEqual(model.loadMoreError, .rateLimited)
    XCTAssertEqual(model.state, .loaded)
  }

  func testChangingTheFilterRestartsFromPageOne() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [image("a")], hasMore: true)])
    let model = MediaGalleryViewModel(api: api)
    await model.load()
    await model.select(kind: .video)
    XCTAssertEqual(model.kind, .video)
    let calls = await api.listCalls
    XCTAssertEqual(calls.map(\.kind), [nil, .video])
    XCTAssertEqual(calls.map(\.page), [1, 1])
  }

  func testASlowResponseForAnOldFilterCannotOverwriteTheNewOne() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [image("slow")], hasMore: false)])
    await api.hold(kind: nil)
    let model = MediaGalleryViewModel(api: api)
    let first = Task { await model.load() }
    while await api.listCalls.isEmpty { await Task.yield() }

    await api.setPages([1: MediaPage(items: [image("fresh")], hasMore: false)])
    await model.select(kind: .image)
    await api.release()
    await first.value
    XCTAssertEqual(model.items.map(\.id), ["fresh"])
  }

  func testNewestImageIsReportedAfterARefresh() async {
    let api = FakeMediaAPI()
    let video = MediaItem(id: "v", kind: .video, fileName: "v.mp4", mimeType: "video/mp4", createdAt: referenceDate)
    await api.setPages([1: MediaPage(items: [video, image("a"), image("b")], hasMore: false)])
    let collector = Collector()
    let model = MediaGalleryViewModel(api: api) { await collector.add($0.id) }
    await model.load()
    let ids = await collector.ids
    XCTAssertEqual(ids, ["a"])
  }

  func testAVideoOnlyFilterNeverReportsALatestImage() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [image("a")], hasMore: false)])
    let collector = Collector()
    let model = MediaGalleryViewModel(api: api) { await collector.add($0.id) }
    await model.select(kind: .video)
    let ids = await collector.ids
    XCTAssertTrue(ids.isEmpty)
  }
}

@MainActor
final class MediaDetailViewModelTests: XCTestCase {
  func testPrepareKeepsAUsableUrlWithoutANetworkCall() async {
    let api = FakeMediaAPI()
    let model = MediaDetailViewModel(
      item: image("a", expires: referenceDate.addingTimeInterval(900)), api: api, now: { referenceDate })
    await model.prepare()
    let calls = await api.detailCalls
    XCTAssertEqual(calls, 0)
    XCTAssertEqual(model.state, .ready)
  }

  func testPrepareRefetchesAUrlThatIsAboutToLapse() async {
    let api = FakeMediaAPI()
    let fresh = image("a", expires: referenceDate.addingTimeInterval(900))
    await api.setDetail([fresh])
    let model = MediaDetailViewModel(
      item: image("a", expires: referenceDate.addingTimeInterval(30)), api: api, now: { referenceDate })
    await model.prepare()
    XCTAssertEqual(model.item, fresh)
    XCTAssertEqual(model.state, .ready)
  }

  func testPlaybackFailureRefetchesAFreshUrl() async {
    let api = FakeMediaAPI()
    let fresh = image("a", expires: referenceDate.addingTimeInterval(900))
    await api.setDetail([fresh])
    let model = MediaDetailViewModel(item: image("a"), api: api, now: { referenceDate })
    let refreshed = await model.playbackFailed()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(model.item, fresh)
  }

  func testRepeatedPlaybackFailuresStopRefetching() async {
    let api = FakeMediaAPI()
    await api.setDetail([image("a")])
    let model = MediaDetailViewModel(item: image("a"), api: api, now: { referenceDate })
    var results: [Bool] = []
    for _ in 0..<5 { results.append(await model.playbackFailed()) }
    XCTAssertEqual(results, [true, true, false, false, false])
    let calls = await api.detailCalls
    XCTAssertEqual(calls, MediaDetailViewModel.maxConsecutiveRefreshes)
    XCTAssertEqual(model.state, .failed(.malformedResponse))
  }

  func testPlaybackSuccessRestoresTheRefreshBudget() async {
    let api = FakeMediaAPI()
    await api.setDetail([image("a")])
    let model = MediaDetailViewModel(item: image("a"), api: api, now: { referenceDate })
    _ = await model.playbackFailed()
    _ = await model.playbackFailed()
    model.playbackSucceeded()
    let refreshed = await model.playbackFailed()
    XCTAssertTrue(refreshed)
  }

  func testRefetchFailureSurfacesTheError() async {
    let api = FakeMediaAPI()
    await api.setFailure(.notFound)
    let model = MediaDetailViewModel(item: image("a"), api: api, now: { referenceDate })
    let refreshed = await model.playbackFailed()
    XCTAssertFalse(refreshed)
    XCTAssertEqual(model.state, .failed(.notFound))
  }

  func testRetryAfterFailureStartsWithAFreshBudget() async {
    let api = FakeMediaAPI()
    await api.setDetail([image("a")])
    let model = MediaDetailViewModel(item: image("a"), api: api, now: { referenceDate })
    for _ in 0..<3 { _ = await model.playbackFailed() }
    XCTAssertEqual(model.state, .failed(.malformedResponse))
    await model.retry()
    XCTAssertEqual(model.state, .ready)
    let refreshed = await model.playbackFailed()
    XCTAssertTrue(refreshed)
  }

  func testAFreshDetailWithoutAUrlIsAFailure() async {
    let api = FakeMediaAPI()
    await api.setDetail([
      MediaItem(id: "a", kind: .image, fileName: "a.png", mimeType: "image/png", createdAt: referenceDate)
    ])
    let model = MediaDetailViewModel(item: image("a"), api: api, now: { referenceDate })
    let refreshed = await model.playbackFailed()
    XCTAssertFalse(refreshed)
    XCTAssertEqual(model.state, .failed(.notFound))
  }
}

@MainActor
final class MediaPlayerConfigurationTests: XCTestCase {
  func testStandardConfigurationEnablesAirPlayAndPictureInPicture() {
    let configuration = MediaPlayerConfiguration.standard
    XCTAssertTrue(configuration.allowsExternalPlayback)
    XCTAssertTrue(configuration.allowsPictureInPicture)
    XCTAssertTrue(configuration.startsPictureInPictureAutomaticallyFromInline)
    XCTAssertTrue(configuration.usesExternalPlaybackWhileExternalScreenIsActive)
    XCTAssertTrue(configuration.continuesPlaybackInBackground)
  }

  func testMadePlayerCarriesTheExternalPlaybackFlag() throws {
    let url = try XCTUnwrap(URL(string: "https://s3.example/clip.mp4"))
    XCTAssertTrue(MediaPlayerConfiguration.standard.makePlayer(url: url).allowsExternalPlayback)

    var off = MediaPlayerConfiguration.standard
    off.allowsExternalPlayback = false
    XCTAssertFalse(off.makePlayer(url: url).allowsExternalPlayback)
  }

  func testMadePlayerPlaysTheGivenUrl() throws {
    let url = try XCTUnwrap(URL(string: "https://s3.example/clip.mp4"))
    let asset = MediaPlayerConfiguration.standard.makePlayer(url: url).currentItem?.asset as? AVURLAsset
    XCTAssertEqual(asset?.url, url)
  }

  #if os(iOS)
    func testPlayerItemKeepsPlayingInTheBackgroundForAudio() throws {
      let url = try XCTUnwrap(URL(string: "https://s3.example/song.mp3"))
      let player = MediaPlayerConfiguration.standard.makePlayer(url: url)
      XCTAssertEqual(player.audiovisualBackgroundPlaybackPolicy, .continuesIfPossible)
    }
  #endif
}

private struct StubDownloader: ImageDownloading {
  let result: Result<Data, URLError>
  func download(_ url: URL) async throws -> Data { try result.get() }
}

final class ThumbnailPublishingTests: XCTestCase {
  /// A real, tiny PNG, so the encoder is exercised on genuine image bytes.
  private func pngData(width: Int, height: Int) throws -> Data {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try XCTUnwrap(context.makeImage())
    let output = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return output as Data
  }

  func testThumbnailShrinksTheLongestSideAndKeepsAspect() throws {
    let jpeg = try XCTUnwrap(ThumbnailEncoder.jpegThumbnail(from: pngData(width: 1600, height: 800), maxPixelSize: 400))
    let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 400)
    XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 200)
  }

  func testNonImageBytesProduceNoThumbnail() {
    XCTAssertNil(ThumbnailEncoder.jpegThumbnail(from: Data("hello".utf8)))
  }

  func testPublisherRecordsAShrunkThumbnailForTheLatestImage() async throws {
    let store = InMemoryWidgetSnapshotStore()
    let reloader = RecordingReloader()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: reloader, now: { referenceDate })
    let publisher = LatestGenerationPublisher(
      recorder: recorder, downloader: StubDownloader(result: .success(try pngData(width: 1200, height: 1200))))
    await publisher.publish(image("m1"))

    let latest = try XCTUnwrap(store.load()?.latestGeneration)
    XCTAssertEqual(latest.mediaID, "m1")
    XCTAssertEqual(latest.title, "m1")
    let bytes = try XCTUnwrap(store.thumbnailData(fileName: try XCTUnwrap(latest.thumbnailFileName)))
    let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
    let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, ThumbnailEncoder.defaultMaxPixelSize)
    XCTAssertEqual(reloader.reloads, [[WidgetKind.latestGeneration]])
  }

  func testPublisherStillRecordsTheTitleWhenTheDownloadFails() async throws {
    let store = InMemoryWidgetSnapshotStore()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: RecordingReloader(), now: { referenceDate })
    let publisher = LatestGenerationPublisher(
      recorder: recorder, downloader: StubDownloader(result: .failure(URLError(.timedOut))))
    await publisher.publish(image("m1"))
    XCTAssertEqual(store.load()?.latestGeneration?.mediaID, "m1")
    XCTAssertNil(store.load()?.latestGeneration?.thumbnailFileName)
  }

  func testPublisherIgnoresVideoAndAudio() async {
    let store = InMemoryWidgetSnapshotStore()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: RecordingReloader(), now: { referenceDate })
    let publisher = LatestGenerationPublisher(recorder: recorder, downloader: StubDownloader(result: .success(Data())))
    await publisher.publish(
      MediaItem(id: "v", kind: .video, fileName: "v.mp4", mimeType: "video/mp4", createdAt: referenceDate))
    XCTAssertNil(store.load())
  }
}
