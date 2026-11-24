import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import B4MKit

private final class CountingDownloader: ImageDownloading, @unchecked Sendable {
  private let lock = NSLock()
  private var _calls = 0
  private let delay: Duration
  private let result: Result<Data, URLError>

  init(result: Result<Data, URLError>, delay: Duration = .zero) {
    self.result = result
    self.delay = delay
  }

  private var _cancellations = 0

  var calls: Int { lock.withLock { _calls } }
  var cancellations: Int { lock.withLock { _cancellations } }

  func download(_ url: URL) async throws -> Data {
    lock.withLock { _calls += 1 }
    if delay > .zero {
      do {
        try await Task.sleep(for: delay)
      } catch {
        lock.withLock { _cancellations += 1 }
        throw error
      }
    }
    return try result.get()
  }
}

private func pngData(width: Int, height: Int) throws -> Data {
  let context = try XCTUnwrap(
    CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
  context.setFillColor(red: 0.9, green: 0.4, blue: 0.1, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  let image = try XCTUnwrap(context.makeImage())
  let output = NSMutableData()
  let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil))
  CGImageDestinationAddImage(destination, image, nil)
  XCTAssertTrue(CGImageDestinationFinalize(destination))
  return output as Data
}

/// Polls instead of sleeping a fixed time, so a slow runner cannot reorder the steps a test depends on.
private func waitUntil(
  timeout: Duration = .seconds(5), _ condition: @escaping @Sendable () -> Bool
) async throws {
  let deadline = ContinuousClock.now + timeout
  while !condition() {
    guard ContinuousClock.now < deadline else {
      XCTFail("condition not met within \(timeout)")
      return
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}

final class ThumbnailCacheTests: XCTestCase {
  private let url = URL(string: "https://s3.example/files/f1.png?X-Amz-Signature=aaa&X-Amz-Date=1")!
  private let resigned = URL(string: "https://s3.example/files/f1.png?X-Amz-Signature=bbb&X-Amz-Date=2")!

  func testKeyIgnoresTheSignatureButNotThePath() {
    XCTAssertEqual(ThumbnailCache.key(for: url), ThumbnailCache.key(for: resigned))
    XCTAssertEqual(ThumbnailCache.key(for: url), "https://s3.example/files/f1.png")
    XCTAssertNotEqual(
      ThumbnailCache.key(for: url), ThumbnailCache.key(for: URL(string: "https://s3.example/files/f2.png?sig=a")!))
  }

  func testLoadedThumbnailIsReadableSynchronouslyUnderAResignedURL() async throws {
    let downloader = CountingDownloader(result: .success(try pngData(width: 40, height: 20)))
    let cache = ThumbnailCache(downloader: downloader)
    XCTAssertNil(cache.cachedImage(for: url))

    _ = try await cache.image(for: url)

    XCTAssertNotNil(cache.cachedImage(for: resigned))
    _ = try await cache.image(for: resigned)
    XCTAssertEqual(downloader.calls, 1)
  }

  func testDownsamplesTheLongestSideAndKeepsAspect() async throws {
    let cache = ThumbnailCache(
      downloader: CountingDownloader(result: .success(try pngData(width: 1600, height: 800))), maxPixelSize: 400)
    let image = try await cache.image(for: url)
    XCTAssertEqual(image.width, 400)
    XCTAssertEqual(image.height, 200)
  }

  func testConcurrentRequestsForOneFileShareADownload() async throws {
    let downloader = CountingDownloader(
      result: .success(try pngData(width: 10, height: 10)), delay: .milliseconds(50))
    let cache = ThumbnailCache(downloader: downloader)
    let (url, resigned) = (url, resigned)
    async let first = cache.image(for: url)
    async let second = cache.image(for: resigned)
    _ = try await (first, second)
    XCTAssertEqual(downloader.calls, 1)
  }

  func testCancellingTheOnlyWaiterCancelsTheDownload() async throws {
    let downloader = CountingDownloader(result: .success(try pngData(width: 10, height: 10)), delay: .seconds(10))
    let cache = ThumbnailCache(downloader: downloader)
    let url = url
    let waiter = Task { try await cache.image(for: url) }
    try await waitUntil { cache.waiterCount(for: url) == 1 }
    waiter.cancel()
    _ = try? await waiter.value
    XCTAssertEqual(downloader.cancellations, 1)
    XCTAssertNil(cache.cachedImage(for: url))
  }

  func testCancellingOneWaiterKeepsTheSharedDownloadForTheOther() async throws {
    let downloader = CountingDownloader(result: .success(try pngData(width: 10, height: 10)), delay: .seconds(1))
    let cache = ThumbnailCache(downloader: downloader)
    let (url, resigned) = (url, resigned)
    let leaving = Task { try await cache.image(for: url) }
    let staying = Task { try await cache.image(for: resigned) }
    // Cancel only once both have joined; otherwise `leaving` could be the sole waiter and cancel the download.
    try await waitUntil { cache.waiterCount(for: url) == 2 }
    leaving.cancel()
    _ = try await staying.value
    XCTAssertEqual(downloader.calls, 1)
    XCTAssertEqual(downloader.cancellations, 0)
    XCTAssertNotNil(cache.cachedImage(for: url))
  }

  func testRemoveAllDropsThumbnailsAndCancelsDownloads() async throws {
    let png = try pngData(width: 10, height: 10)
    let cache = ThumbnailCache(downloader: CountingDownloader(result: .success(png)))
    let url = url
    _ = try await cache.image(for: url)
    XCTAssertNotNil(cache.cachedImage(for: url))

    let slow = CountingDownloader(result: .success(png), delay: .seconds(10))
    let pending = ThumbnailCache(downloader: slow)
    let waiter = Task { try await pending.image(for: url) }
    try await waitUntil { pending.waiterCount(for: url) == 1 }

    cache.removeAll()
    pending.removeAll()
    _ = try? await waiter.value

    XCTAssertNil(cache.cachedImage(for: url))
    XCTAssertEqual(slow.cancellations, 1)
    XCTAssertEqual(pending.waiterCount(for: url), 0)
    XCTAssertNil(pending.cachedImage(for: url))
  }

  func testFailureIsNotCachedSoTheNextRequestRetries() async throws {
    let downloader = CountingDownloader(result: .failure(URLError(.badServerResponse)))
    let cache = ThumbnailCache(downloader: downloader)
    do {
      _ = try await cache.image(for: url)
      XCTFail("expected a failure")
    } catch {}
    XCTAssertNil(cache.cachedImage(for: url))
    _ = try? await cache.image(for: url)
    XCTAssertEqual(downloader.calls, 2)
  }

  func testNonImageBytesFail() async {
    let cache = ThumbnailCache(downloader: CountingDownloader(result: .success(Data("hello".utf8))))
    do {
      _ = try await cache.image(for: url)
      XCTFail("expected a decode failure")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .cannotDecodeContentData)
    }
  }
}

final class ThumbnailCacheDiskTests: XCTestCase {
  private let url = URL(string: "https://s3.example/files/f1.png?X-Amz-Signature=aaa&X-Amz-Date=1")!
  private let resigned = URL(string: "https://s3.example/files/f1.png?X-Amz-Signature=bbb&X-Amz-Date=2")!
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func store(byteLimit: Int = 10 * 1024 * 1024) -> ImageDiskStore {
    ImageDiskStore(directory: directory, byteLimit: byteLimit)
  }

  func testAFreshMemoryTierReadsBytesAnEarlierOneStoredUnderAResignedURL() async throws {
    let png = try pngData(width: 40, height: 20)
    let first = CountingDownloader(result: .success(png))
    _ = try await ThumbnailCache(downloader: first, disk: store()).image(for: url)

    // A new instance stands in for a relaunch or an evicted memory tier.
    let second = CountingDownloader(result: .success(png))
    let image = try await ThumbnailCache(downloader: second, disk: store()).image(for: resigned)

    XCTAssertEqual(first.calls, 1)
    XCTAssertEqual(second.calls, 0)
    XCTAssertEqual(image.width, 40)
  }

  func testBytesThatDoNotDecodeAreNotStored() async throws {
    let disk = store()
    let cache = ThumbnailCache(downloader: CountingDownloader(result: .success(Data("hello".utf8))), disk: disk)
    _ = try? await cache.image(for: url)
    XCTAssertNil(disk.data(for: ThumbnailCache.key(for: url)))
  }

  func testUndecodableStoredBytesAreDroppedAndRefetched() async throws {
    let disk = store()
    let key = ThumbnailCache.key(for: url)
    disk.store(Data("corrupt".utf8), for: key, generation: disk.generation)
    let downloader = CountingDownloader(result: .success(try pngData(width: 10, height: 10)))

    _ = try await ThumbnailCache(downloader: downloader, disk: disk).image(for: url)

    XCTAssertEqual(downloader.calls, 1)
    XCTAssertNotEqual(disk.data(for: key), Data("corrupt".utf8))
  }

  func testRemoveAllWipesTheDiskLayer() async throws {
    let disk = store()
    let cache = ThumbnailCache(
      downloader: CountingDownloader(result: .success(try pngData(width: 10, height: 10))), disk: disk)
    _ = try await cache.image(for: url)
    XCTAssertNotNil(disk.data(for: ThumbnailCache.key(for: url)))

    cache.removeAll()

    XCTAssertNil(disk.data(for: ThumbnailCache.key(for: url)))
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
  }

  func testAWriteStartedBeforeRemoveAllIsDropped() {
    let disk = store()
    let generation = disk.generation
    disk.removeAll()
    disk.store(Data("bytes".utf8), for: "k", generation: generation)
    XCTAssertNil(disk.data(for: "k"))
  }

  func testTrimEvictsTheLeastRecentlyReadFirst() throws {
    let disk = store(byteLimit: 25)
    let ten = Data(repeating: 1, count: 10)
    disk.store(ten, for: "a", generation: disk.generation)
    disk.store(ten, for: "b", generation: disk.generation)
    // Backdate both so the read below is unambiguously the most recent touch.
    for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
      try FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSinceNow: -60)],
        ofItemAtPath: directory.appendingPathComponent(name).path)
    }
    XCTAssertNotNil(disk.data(for: "a"))

    disk.store(ten, for: "c", generation: disk.generation)

    XCTAssertNotNil(disk.data(for: "a"))
    XCTAssertNil(disk.data(for: "b"))
    XCTAssertNotNil(disk.data(for: "c"))
  }

  func testAFileLargerThanTheWholeStoreIsNotKept() {
    let disk = store(byteLimit: 5)
    disk.store(Data(repeating: 1, count: 10), for: "big", generation: disk.generation)
    XCTAssertNil(disk.data(for: "big"))
  }
}
