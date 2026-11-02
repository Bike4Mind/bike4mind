import Foundation

/// `AttachmentSource` over a real `NSItemProvider`.
///
/// `NSItemProvider` is not `Sendable`, but a provider is only ever read through its own thread-safe async
/// loading API and is never mutated after the system hands it over, so the box is sound.
public struct ItemProviderAttachment: AttachmentSource, @unchecked Sendable {
  private let provider: NSItemProvider
  private let stagingDirectory: URL

  /// - Parameter stagingDirectory: where file representations are copied; the caller owns what lands there.
  public init(provider: NSItemProvider, stagingDirectory: URL) {
    self.provider = provider
    self.stagingDirectory = stagingDirectory
  }

  public var typeIdentifiers: [String] { provider.registeredTypeIdentifiers }
  public var suggestedName: String? { provider.suggestedName }

  public func loadURL() async throws -> URL {
    let item = try await provider.loadItem(forTypeIdentifier: "public.url")
    if let url = item as? URL { return url }
    if let string = item as? String, let url = URL(string: string) { return url }
    if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) { return url }
    throw ShareItemLoadError.unsupported
  }

  public func loadText() async throws -> String {
    let item = try await provider.loadItem(forTypeIdentifier: "public.plain-text")
    if let string = item as? String { return string }
    if let attributed = item as? NSAttributedString { return attributed.string }
    if let data = item as? Data, let string = String(data: data, encoding: .utf8) { return string }
    throw ShareItemLoadError.unsupported
  }

  public func loadFile(typeIdentifier: String) async throws -> URL {
    let directory = stagingDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return try await withCheckedThrowingContinuation { continuation in
      _ = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
        guard let url else {
          continuation.resume(throwing: error ?? ShareItemLoadError.unsupported)
          return
        }
        // The system deletes `url` when this closure returns, so the copy happens here.
        do {
          let copy = directory.appending(path: url.lastPathComponent)
          try FileManager.default.copyItem(at: url, to: copy)
          continuation.resume(returning: copy)
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }
}
