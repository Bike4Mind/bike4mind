import Foundation
import UniformTypeIdentifiers

/// A file the app itself produced (camera, photo picker): the same loader that handles shared items then
/// applies the same type detection, HEIC transcode and naming to it.
public struct LocalFileAttachment: AttachmentSource {
  public let fileURL: URL
  public let typeIdentifiers: [String]
  public let suggestedName: String?

  public init(fileURL: URL, type: UTType, suggestedName: String? = nil) {
    self.fileURL = fileURL
    typeIdentifiers = [type.identifier]
    self.suggestedName = suggestedName
  }

  public func loadURL() async throws -> URL { fileURL }

  public func loadText() async throws -> String {
    throw ShareItemLoadError.unsupported
  }

  public func loadFile(typeIdentifier: String) async throws -> URL { fileURL }
}
