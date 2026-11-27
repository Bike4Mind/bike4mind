#if DEBUG
  import AVFoundation
  import B4MKit
  import UIKit

  /// Generates small local files (a PNG per image, one WAV, one MP4) so the fixture gallery has real content to
  /// open: the zoomable image, the audio player and the video player all render with no server.
  actor FixtureMediaFiles {
    static let shared = FixtureMediaFiles()

    private let directory = FileManager.default.temporaryDirectory.appending(
      path: "b4m-fixture-media", directoryHint: .isDirectory)

    /// `item` with a `file:` URL to generated content in place of the missing storage URL.
    func withContent(_ item: MediaItem, index: Int) async -> MediaItem {
      let url: URL?
      switch item.kind {
      case .image: url = image(index: index)
      case .audio: url = tone()
      case .video: url = await video()
      }
      return MediaItem(
        id: item.id, kind: item.kind, fileName: item.fileName, mimeType: item.mimeType, createdAt: item.createdAt,
        url: url)
    }

    private func file(_ name: String) -> URL? {
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      return directory.appending(path: name)
    }

    private func exists(_ url: URL) -> Bool {
      FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    private func image(index: Int) -> URL? {
      guard let url = file("image-\(index).png") else { return nil }
      if exists(url) { return url }
      let size = CGSize(width: 600, height: 800)
      let hue = CGFloat(index % 12) / 12
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1  // pixels, not points: the device scale would make each file several MB
      let data = UIGraphicsImageRenderer(size: size, format: format).pngData { context in
        let colors = [
          UIColor(hue: hue, saturation: 0.55, brightness: 0.95, alpha: 1).cgColor,
          UIColor(hue: (hue + 0.12).truncatingRemainder(dividingBy: 1), saturation: 0.85, brightness: 0.45, alpha: 1)
            .cgColor,
        ]
        if let gradient = CGGradient(
          colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])
        {
          context.cgContext.drawLinearGradient(
            gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
        let label = "#\(index)" as NSString
        let attributes: [NSAttributedString.Key: Any] = [
          .font: UIFont.systemFont(ofSize: 150, weight: .heavy),
          .foregroundColor: UIColor.white.withAlphaComponent(0.85),
        ]
        let labelSize = label.size(withAttributes: attributes)
        label.draw(
          at: CGPoint(x: (size.width - labelSize.width) / 2, y: (size.height - labelSize.height) / 2),
          withAttributes: attributes)
      }
      return (try? data.write(to: url)) != nil ? url : nil
    }

    /// Three seconds of 440 Hz as a 16-bit mono WAV; AVPlayer plays it directly.
    private func tone() -> URL? {
      guard let url = file("tone.wav") else { return nil }
      if exists(url) { return url }
      let sampleRate = 44_100
      let samples = sampleRate * 3
      var pcm = Data(capacity: samples * 2)
      for index in 0..<samples {
        let fade = min(1, Double(min(index, samples - index)) / Double(sampleRate / 10))
        pcm.appendLittleEndian(Int16(sin(2 * Double.pi * 440 * Double(index) / Double(sampleRate)) * fade * 9_000))
      }
      var wav = Data("RIFF".utf8)
      wav.appendLittleEndian(UInt32(36 + pcm.count))
      wav.append(Data("WAVEfmt ".utf8))
      wav.appendLittleEndian(UInt32(16))
      wav.appendLittleEndian(UInt16(1))  // PCM
      wav.appendLittleEndian(UInt16(1))  // mono
      wav.appendLittleEndian(UInt32(sampleRate))
      wav.appendLittleEndian(UInt32(sampleRate * 2))
      wav.appendLittleEndian(UInt16(2))
      wav.appendLittleEndian(UInt16(16))
      wav.append(Data("data".utf8))
      wav.appendLittleEndian(UInt32(pcm.count))
      wav.append(pcm)
      return (try? wav.write(to: url)) != nil ? url : nil
    }

    /// Three seconds of a colour sweep, 320x240 H.264.
    private func video() async -> URL? {
      guard let url = file("sweep.mp4") else { return nil }
      if exists(url) { return url }
      let width = 320
      let height = 240
      guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return nil }
      let input = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
          kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
      guard writer.canAdd(input) else { return nil }
      writer.add(input)
      guard writer.startWriting() else { return nil }
      writer.startSession(atSourceTime: .zero)
      let frameCount = 60
      for frame in 0..<frameCount {
        while !input.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(5)) }
        guard let buffer = Self.frame(width: width, height: height, progress: Double(frame) / Double(frameCount)) else {
          return nil
        }
        adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 20))
      }
      input.markAsFinished()
      await writer.finishWriting()
      return writer.status == .completed ? url : nil
    }

    private static func frame(width: Int, height: Int, progress: Double) -> CVPixelBuffer? {
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
      guard let buffer else { return nil }
      CVPixelBufferLockBaseAddress(buffer, [])
      defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
      guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
      let stride = CVPixelBufferGetBytesPerRow(buffer)
      let color = UIColor(hue: progress, saturation: 0.6, brightness: 0.9, alpha: 1)
      var red: CGFloat = 0
      var green: CGFloat = 0
      var blue: CGFloat = 0
      color.getRed(&red, green: &green, blue: &blue, alpha: nil)
      let pixel = UInt32(blue * 255) | UInt32(green * 255) << 8 | UInt32(red * 255) << 16 | 0xFF << 24
      for row in 0..<height {
        let line = base.advanced(by: row * stride).assumingMemoryBound(to: UInt32.self)
        for column in 0..<width { line[column] = pixel }
      }
      return buffer
    }
  }

  extension Data {
    fileprivate mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
      Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }
  }
#endif
