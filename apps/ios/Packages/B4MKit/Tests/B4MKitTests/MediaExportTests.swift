import XCTest

@testable import B4MKit

@MainActor
final class MediaExportTests: XCTestCase {
  private let directory = FileManager.default.temporaryDirectory.appending(
    path: "ExportTests-\(UUID().uuidString)", directoryHint: .isDirectory)

  private func item(
    kind: MediaKind = .image, name: String = "cat.png", mime: String = "image/png",
    url: String? = "https://s3.example/a",
    expires: Date? = nil
  ) -> MediaItem {
    MediaItem(
      id: "f1", kind: kind, fileName: name, mimeType: mime, createdAt: Date(), url: url.flatMap(URL.init),
      urlExpiresAt: expires)
  }

  private func exporter(_ api: FakeMediaAPI = FakeMediaAPI(), downloads: Locked<[URL]> = Locked([])) -> MediaExporter {
    MediaExporter(
      api: api,
      download: { url in
        downloads.mutate { $0.append(url) }
        let file = FileManager.default.temporaryDirectory.appending(path: "dl-\(UUID().uuidString)")
        try Data([1, 2, 3]).write(to: file)
        return file
      }, directory: directory)
  }

  func testExportNamesTheFileAfterTheItem() async throws {
    let file = try await exporter().export(item())
    XCTAssertEqual(file.lastPathComponent, "cat.png")
    XCTAssertEqual(try Data(contentsOf: file), Data([1, 2, 3]))
  }

  func testMissingExtensionComesFromTheMIMEType() {
    XCTAssertEqual(MediaExporter.fileName(for: item(name: "clip", mime: "video/quicktime")), "clip.mov")
    XCTAssertEqual(MediaExporter.fileName(for: item(name: "a/b", mime: "audio/wav")), "a-b.wav")
    XCTAssertEqual(MediaExporter.fileName(for: item(name: "", mime: "x/unknown")), "image.png")
  }

  func testLapsedURLIsRefetchedBeforeDownloading() async throws {
    let api = FakeMediaAPI()
    await api.setDetail([item(url: "https://s3.example/fresh")])
    let downloads = Locked<[URL]>([])
    _ = try await exporter(api, downloads: downloads).export(item(expires: Date().addingTimeInterval(-10)))
    XCTAssertEqual(downloads.current.map(\.absoluteString), ["https://s3.example/fresh"])
  }

  func testItemWithoutURLIsNotAvailable() async {
    let api = FakeMediaAPI()
    await api.setDetail([item(url: nil)])
    do {
      _ = try await exporter(api).export(item(url: nil))
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? MediaExportError, .notAvailable)
    }
  }

  func testAudioCannotGoToPhotos() async {
    let model = MediaExportViewModel(exporter: exporter(), saveToPhotos: { _, _ in XCTFail("must not save") })
    await model.start(.photos, item: item(kind: .audio, name: "s.mp3", mime: "audio/mpeg"))
    guard case .failed(let message) = model.state else { return XCTFail("expected failure") }
    XCTAssertTrue(message.contains("Files"))
  }

  func testPhotosSaveReceivesTheFileAndKind() async {
    let saved = Locked<[MediaKind]>([])
    let model = MediaExportViewModel(
      exporter: exporter(), saveToPhotos: { _, kind in saved.mutate { $0.append(kind) } })
    await model.start(.photos, item: item(kind: .video, name: "v.mp4", mime: "video/mp4"))
    XCTAssertEqual(saved.current, [.video])
    XCTAssertEqual(model.state, .finished("Video saved to Photos."))
  }

  func testDeniedPhotosAccessIsReadable() async {
    let model = MediaExportViewModel(exporter: exporter(), saveToPhotos: { _, _ in throw PhotosSaveError.denied })
    await model.start(.photos, item: item())
    XCTAssertEqual(model.state, .failed(PhotosSaveError.denied.message))
  }

  func testShareHandsBackTheFile() async {
    let model = MediaExportViewModel(exporter: exporter(), saveToPhotos: { _, _ in })
    await model.start(.share, item: item())
    guard case .ready(.share, let file) = model.state else { return XCTFail("expected a ready file") }
    XCTAssertEqual(file.lastPathComponent, "cat.png")
  }

  func testRemixPrefillsThePromptAndMapsAudioToMusic() {
    func seed(_ kind: MediaKind, prompt: String?) -> StudioSeed? {
      StudioSeed.remix(
        of: MediaItem(id: "x", kind: kind, fileName: "x", mimeType: "x/y", createdAt: Date(), prompt: prompt))
    }
    XCTAssertEqual(seed(.audio, prompt: " a song ")?.kind, .music)
    XCTAssertEqual(seed(.audio, prompt: " a song ")?.prompt, "a song")
    XCTAssertEqual(seed(.video, prompt: "p")?.kind, .video)
    XCTAssertTrue(seed(.image, prompt: "p")?.inputs.isEmpty ?? false)
    XCTAssertNil(seed(.image, prompt: nil))
    XCTAssertNil(seed(.image, prompt: "  "))
  }
}
