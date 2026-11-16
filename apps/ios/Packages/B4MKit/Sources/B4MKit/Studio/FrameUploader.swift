import Foundation

/// Why a grabbed frame did not become a usable image.
public enum FrameUploadError: Error, Equatable, Sendable {
  case blocked
  /// The scan had not finished by the time the poll budget ran out.
  case notReady
  case api(APIError)
}

/// Uploads one still (a frame grabbed from a video) as a Files entry and returns it as an image the rest of Studio
/// can edit or animate. The PUT itself is injected: the app owns the URLSession, and tests need no network.
public struct FrameUploader: Sendable {
  public typealias Put = @Sendable (_ url: URL, _ data: Data, _ contentType: String) async throws -> Void

  private let capture: any FileUploading
  private let media: any MediaAPI
  private let put: Put
  private let sleep: @Sendable (Duration) async throws -> Void
  private let maximumPolls: Int

  public init(
    capture: any FileUploading, media: any MediaAPI, put: @escaping Put,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    maximumPolls: Int = 20
  ) {
    self.capture = capture
    self.media = media
    self.put = put
    self.sleep = sleep
    self.maximumPolls = maximumPolls
  }

  public func upload(jpeg data: Data, fileName: String) async throws -> MediaItem {
    do {
      let ticket = try await capture.createUpload(fileName: fileName, mimeType: "image/jpeg", byteCount: data.count)
      try await put(ticket.uploadURL, data, "image/jpeg")
      try await waitUntilClean(ticket.fileID)
      return try await media.media(id: ticket.fileID)
    } catch let error as FrameUploadError {
      throw error
    } catch let error as APIError {
      throw FrameUploadError.api(error)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw FrameUploadError.api(.offline)
    }
  }

  private func waitUntilClean(_ fileID: String) async throws {
    for attempt in 0..<maximumPolls {
      switch try await capture.fileStatus(fileID: fileID) {
      case .clean, .unscanned: return
      case .blocked: throw FrameUploadError.blocked
      case .pending, .scanning: if attempt < maximumPolls - 1 { try await sleep(.milliseconds(750)) }
      }
    }
    throw FrameUploadError.notReady
  }
}
