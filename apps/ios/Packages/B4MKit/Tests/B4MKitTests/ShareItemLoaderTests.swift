import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import B4MKit

final class ShareItemLoaderTests: XCTestCase {
  private let temp = TempDirectory()
  private let loader = ShareItemLoader()

  func testAWebLinkBecomesAURLItem() async throws {
    let link = URL(string: "https://example.com/article")!
    let item = try await loader.load(FakeAttachment(typeIdentifiers: ["public.url", "public.plain-text"], url: link))
    XCTAssertEqual(item, .url(link))
  }

  func testPlainTextBecomesATextItem() async throws {
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.utf8-plain-text"], text: "  buy oat milk  \n"))
    XCTAssertEqual(item, .text("buy oat milk"))
  }

  func testTextThatIsJustALinkBecomesAURLItem() async throws {
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.plain-text"], text: "https://example.com/a?b=1"))
    XCTAssertEqual(item, .url(URL(string: "https://example.com/a?b=1")!))
  }

  func testTextWithALinkAndWordsStaysText() async throws {
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.plain-text"], text: "see https://example.com now"))
    XCTAssertEqual(item, .text("see https://example.com now"))
  }

  func testBlankTextIsRejected() async {
    do {
      _ = try await loader.load(FakeAttachment(typeIdentifiers: ["public.plain-text"], text: "  \n "))
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? ShareItemLoadError, .empty)
    }
  }

  func testAnImageBecomesAnImageItemWithItsMimeType() async throws {
    let file = temp.file("IMG_1.png")
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.png", "public.image"], suggestedName: "IMG_1.png", file: file))
    guard case .image(let shared) = item else { return XCTFail("expected image, got \(item)") }
    XCTAssertEqual(shared.mimeType, "image/png")
    XCTAssertEqual(shared.fileName, "IMG_1.png")
    XCTAssertEqual(shared.byteCount, 5)
  }

  func testAPDFBecomesAPDFItem() async throws {
    let file = temp.file("report.pdf")
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["com.adobe.pdf"], suggestedName: "report.pdf", file: file))
    guard case .pdf(let shared) = item else { return XCTFail("expected pdf, got \(item)") }
    XCTAssertEqual(shared.mimeType, "application/pdf")
  }

  func testAPDFWinsOverTheURLItAlsoCarries() async throws {
    let file = temp.file("paper.pdf")
    let item = try await loader.load(
      FakeAttachment(
        typeIdentifiers: ["public.url", "com.adobe.pdf"], suggestedName: "paper.pdf",
        url: URL(string: "https://example.com/paper.pdf"), file: file))
    guard case .pdf = item else { return XCTFail("expected pdf, got \(item)") }
  }

  func testAGenericDocumentBecomesAFileItem() async throws {
    let file = temp.file("budget.xlsx")
    let item = try await loader.load(
      FakeAttachment(
        typeIdentifiers: ["org.openxmlformats.spreadsheetml.sheet"], suggestedName: "budget.xlsx", file: file))
    guard case .file(let shared) = item else { return XCTFail("expected file, got \(item)") }
    XCTAssertEqual(shared.fileName, "budget.xlsx")
    XCTAssertTrue(shared.mimeType.contains("spreadsheetml"))
  }

  func testAFileURLIsClassifiedByTheLoadedFile() async throws {
    let file = temp.file("notes.pdf")
    let item = try await loader.load(
      FakeAttachment(
        typeIdentifiers: ["public.file-url", "com.adobe.pdf"], suggestedName: "notes.pdf", url: file, file: file))
    guard case .pdf = item else { return XCTFail("expected pdf, got \(item)") }
  }

  func testAMissingExtensionIsAddedFromTheType() async throws {
    let file = temp.file("scan")
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.jpeg"], suggestedName: "Scan", file: file))
    XCTAssertEqual(item.file?.fileName, "Scan.jpeg")
  }

  func testUnknownTypesAreUnsupported() async {
    do {
      _ = try await loader.load(FakeAttachment(typeIdentifiers: ["com.example.nonsense-type"]))
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? ShareItemLoadError, .unsupported)
    }
  }

  func testAMixedShareKeepsTheGoodItemsAndCountsTheSkipped() async {
    let good = FakeAttachment(typeIdentifiers: ["public.url"], url: URL(string: "https://example.com")!)
    let bad = FakeAttachment(typeIdentifiers: [])
    let empty = FakeAttachment(typeIdentifiers: ["public.plain-text"], text: "")
    let result = await loader.load([good, bad, empty])
    XCTAssertEqual(result.items, [.url(URL(string: "https://example.com")!)])
    XCTAssertEqual(result.skippedCount, 2)
  }

  func testAnEmptyFileIsRejected() async {
    let file = temp.file("empty.txt", contents: Data())
    do {
      _ = try await loader.load(FakeAttachment(typeIdentifiers: ["public.plain-text", "public.file-url"], file: file))
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? ShareItemLoadError, .empty)
    }
  }

  // MARK: - HEIC

  func testAHEICFileIsTranscodedToAJPEGItem() async throws {
    let heic: URL
    do {
      heic = try writeImage(type: .heic, name: "IMG_0001.heic")
    } catch {
      throw XCTSkip("This host cannot encode HEIC")
    }
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.heic", "public.image"], suggestedName: "IMG_0001.HEIC", file: heic))
    guard case .image(let shared) = item else { return XCTFail("expected image, got \(item)") }
    XCTAssertEqual(shared.mimeType, "image/jpeg")
    XCTAssertEqual(shared.fileName, "IMG_0001.jpg")
    XCTAssertEqual(shared.fileURL.pathExtension, "jpg")
  }

  func testALoadedFilesOwnTypeWinsOverTheDeclaredIdentifier() async throws {
    let png = try writeImage(type: .png, name: "photo.png")
    let item = try await loader.load(
      FakeAttachment(typeIdentifiers: ["public.heic", "public.image"], suggestedName: "IMG_0001.png", file: png))
    XCTAssertEqual(item.file?.mimeType, "image/png")
  }

  func testJPEGCopyProducesAReadableJPEG() throws {
    let png = try writeImage(type: .png, name: "src.png")
    let jpeg = try ImageTranscoder.jpegCopy(of: png)
    XCTAssertEqual(jpeg.pathExtension, "jpg")
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(jpeg as CFURL, nil))
    XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
  }

  func testHEICNamesAreRewrittenAfterTheTranscode() {
    let location = URL(fileURLWithPath: "/tmp/IMG.jpg")
    XCTAssertEqual(ShareItemLoader.fileName(suggested: "IMG_0001.HEIC", location: location, type: .jpeg), "IMG_0001.jpg")
    XCTAssertEqual(ShareItemLoader.fileName(suggested: nil, location: location, type: .jpeg), "IMG.jpg")
    XCTAssertEqual(ShareItemLoader.fileName(suggested: "a/b", location: location, type: nil), "a-b")
  }

  func testHEICAndHEIFNeedATranscode() {
    XCTAssertTrue(ShareItemLoader.needsJPEGTranscode(.heic))
    XCTAssertTrue(ShareItemLoader.needsJPEGTranscode(.heif))
    XCTAssertFalse(ShareItemLoader.needsJPEGTranscode(.jpeg))
    XCTAssertFalse(ShareItemLoader.needsJPEGTranscode(.png))
  }

  // MARK: - Real NSItemProvider

  func testARealItemProviderWithAURLMapsToAURLItem() async throws {
    let link = URL(string: "https://example.com/real")!
    let provider = NSItemProvider(object: link as NSURL)
    let item = try await loader.load(ItemProviderAttachment(provider: provider, stagingDirectory: temp.url))
    XCTAssertEqual(item, .url(link))
  }

  func testARealItemProviderWithAFileIsCopiedIntoTheStagingDirectory() async throws {
    let source = temp.file("origin.pdf")
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: UTType.pdf.identifier, fileOptions: [], visibility: .all
    ) { completion in
      completion(source, false, nil)
      return nil
    }
    provider.suggestedName = "origin.pdf"
    let staging = TempDirectory()
    let item = try await loader.load(ItemProviderAttachment(provider: provider, stagingDirectory: staging.url))
    guard case .pdf(let shared) = item else { return XCTFail("expected pdf, got \(item)") }
    XCTAssertTrue(shared.fileURL.path().hasPrefix(staging.url.path()))
    XCTAssertEqual(try Data(contentsOf: shared.fileURL), Data("hello".utf8))
  }

  private func writeImage(type: UTType, name: String) throws -> URL {
    let url = temp.url.appending(path: name)
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    let image = try XCTUnwrap(context.makeImage())
    guard let sink = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
      throw XCTSkip("No encoder for \(type.identifier)")
    }
    CGImageDestinationAddImage(sink, image, nil)
    guard CGImageDestinationFinalize(sink) else { throw XCTSkip("Encoder failed for \(type.identifier)") }
    return url
  }
}
