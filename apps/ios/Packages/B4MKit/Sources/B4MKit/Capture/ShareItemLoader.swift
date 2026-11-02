import Foundation
import ImageIO
import UniformTypeIdentifiers

/// One attachment of a share request, abstracted from `NSItemProvider` so mapping is testable.
public protocol AttachmentSource: Sendable {
  /// Registered type identifiers, most specific first (the order `NSItemProvider` reports them).
  var typeIdentifiers: [String] { get }
  var suggestedName: String? { get }
  /// The attachment as a URL object (a web link, or a file URL).
  func loadURL() async throws -> URL
  func loadText() async throws -> String
  /// A copy of the file representation for `typeIdentifier`, in a location the caller now owns.
  func loadFile(typeIdentifier: String) async throws -> URL
}

public enum ShareItemLoadError: Error, Equatable, Sendable {
  case unsupported
  case empty
}

/// The outcome of mapping a whole share request: what was usable, and how many attachments were not.
public struct ShareLoadResult: Sendable, Equatable {
  public let items: [ShareItem]
  public let skippedCount: Int
}

/// Maps the attachments of a share request to typed `ShareItem`s. Never throws for one bad attachment:
/// a share with a mix of good and unsupported items keeps the good ones and reports the skip count.
public struct ShareItemLoader: Sendable {
  /// What an attachment is, decided from its type identifiers alone.
  enum Kind: Equatable {
    case file, image, pdf, url, text
  }

  public init() {}

  public func load(_ sources: [any AttachmentSource]) async -> ShareLoadResult {
    var items: [ShareItem] = []
    var skipped = 0
    for source in sources {
      do {
        items.append(try await load(source))
      } catch {
        skipped += 1
      }
    }
    return ShareLoadResult(items: items, skippedCount: skipped)
  }

  public func load(_ source: any AttachmentSource) async throws -> ShareItem {
    guard let kind = Self.kind(of: source.typeIdentifiers) else { throw ShareItemLoadError.unsupported }
    switch kind {
    case .url:
      let url = try await source.loadURL()
      return url.isFileURL ? try await loadFile(from: source, typeIdentifier: nil) : .url(url)
    case .text:
      let text = try await source.loadText().trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { throw ShareItemLoadError.empty }
      // A text share that is just a link (Notes, Messages) is a link.
      if let url = Self.webURL(from: text) { return .url(url) }
      return .text(text)
    case .image, .pdf, .file:
      let identifier = Self.bestFileIdentifier(for: kind, in: source.typeIdentifiers)
      return try await loadFile(from: source, typeIdentifier: identifier)
    }
  }

  // MARK: - Classification

  static func kind(of identifiers: [String]) -> Kind? {
    let types = identifiers.compactMap(UTType.init)
    guard !types.isEmpty else { return nil }
    func contains(_ parent: UTType) -> Bool { types.contains { $0.conforms(to: parent) } }

    // A file URL means a file picked from Files or another app's container; its real type is known once
    // the file is loaded, so it is classified there.
    if identifiers.contains(UTType.fileURL.identifier) { return .file }
    if contains(.image) { return .image }
    if contains(.pdf) { return .pdf }
    // `public.url` also matches `public.file-url`, handled above.
    if contains(.url) { return .url }
    if contains(.text) && !contains(.sourceCode) { return .text }
    if contains(.data) || contains(.item) || contains(.content) { return .file }
    return nil
  }

  private static func bestFileIdentifier(for kind: Kind, in identifiers: [String]) -> String? {
    let parent: UTType? =
      switch kind {
      case .image: .image
      case .pdf: .pdf
      default: nil
      }
    let types = identifiers.compactMap { id in UTType(id).map { (id, $0) } }
    if let parent, let match = types.first(where: { $0.1.conforms(to: parent) }) { return match.0 }
    // Skip pure pointer types: they are not file representations.
    return types.first { !$0.1.conforms(to: .url) }?.0 ?? identifiers.first
  }

  /// A bare http(s) link and nothing else.
  static func webURL(from text: String) -> URL? {
    guard !text.contains(where: \.isWhitespace), let url = URL(string: text),
      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host() != nil
    else { return nil }
    return url
  }

  // MARK: - Files

  private func loadFile(from source: any AttachmentSource, typeIdentifier: String?) async throws -> ShareItem {
    let identifier = typeIdentifier ?? source.typeIdentifiers.first ?? UTType.data.identifier
    var location = try await source.loadFile(typeIdentifier: identifier)
    var type = UTType(filenameExtension: location.pathExtension) ?? UTType(identifier)

    // Photos hands out HEIC; the server's upload gate and every lake parser expect JPEG.
    if let current = type, Self.needsJPEGTranscode(current) {
      location = try ImageTranscoder.jpegCopy(of: location)
      type = .jpeg
    }

    let name = Self.fileName(suggested: source.suggestedName, location: location, type: type)
    let mime = type?.preferredMIMEType ?? "application/octet-stream"
    let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0 else { throw ShareItemLoadError.empty }
    let file = SharedFile(fileURL: location, fileName: name, mimeType: mime, byteCount: size)
    return Self.item(for: file, type: type)
  }

  static func item(for file: SharedFile, type: UTType?) -> ShareItem {
    if type?.conforms(to: .image) == true || file.mimeType.hasPrefix("image/") { return .image(file) }
    if type?.conforms(to: .pdf) == true || file.mimeType == "application/pdf" { return .pdf(file) }
    return .file(file)
  }

  static func needsJPEGTranscode(_ type: UTType) -> Bool {
    type.conforms(to: .heic) || type.conforms(to: .heif)
  }

  /// Keeps the provider's name when it has one; adds the extension when missing and swaps `.heic` for `.jpg`
  /// after a transcode.
  static func fileName(suggested: String?, location: URL, type: UTType?) -> String {
    let raw = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? location.lastPathComponent
    let name = raw.replacingOccurrences(of: "/", with: "-")
    guard let wanted = type?.preferredFilenameExtension else { return name }
    let current = (name as NSString).pathExtension
    if current.isEmpty { return "\(name).\(wanted)" }
    if let currentType = UTType(filenameExtension: current), needsJPEGTranscode(currentType), wanted == "jpeg" {
      return "\((name as NSString).deletingPathExtension).jpg"
    }
    return name
  }
}

enum ImageTranscoder {
  struct Failure: Error {}

  /// Writes a JPEG copy next to `source` and returns it.
  static func jpegCopy(of source: URL, quality: Double = 0.9) throws -> URL {
    guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil) else { throw Failure() }
    let destination = source.deletingPathExtension().appendingPathExtension("jpg")
    guard
      let sink = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw Failure() }
    // Passing the source's properties through keeps orientation, so the JPEG is not rotated.
    let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
    CGImageDestinationAddImageFromSource(sink, imageSource, 0, options)
    guard CGImageDestinationFinalize(sink) else { throw Failure() }
    return destination
  }
}
