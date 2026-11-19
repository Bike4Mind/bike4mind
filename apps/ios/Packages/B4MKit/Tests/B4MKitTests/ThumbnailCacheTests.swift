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

  var calls: Int { lock.withLock { _calls } }

  func download(_ url: URL) async throws -> Data {
    lock.withLock { _calls += 1 }
    if delay > .zero { try await Task.sleep(for: delay) }
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
