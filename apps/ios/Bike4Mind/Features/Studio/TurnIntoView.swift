import AVFoundation
import B4MKit
import SwiftUI
import UIKit

/// One pending "Turn into..." choice on an item.
struct TurnIntoRequest: Identifiable {
  let action: TurnIntoAction
  let item: MediaItem
  var id: String { "\(action)-\(item.id)" }
}

/// The "Turn into..." entries for an item, for a context menu or a toolbar menu. Empty when the item has none.
struct TurnIntoButtons: View {
  let item: MediaItem
  let onSelect: (TurnIntoRequest) -> Void

  var body: some View {
    ForEach(TurnInto.actions(for: item), id: \.self) { action in
      Button(action.title, systemImage: action.systemImage) {
        onSelect(TurnIntoRequest(action: action, item: item))
      }
      .accessibilityIdentifier("turn-into-\(String(describing: action))")
    }
  }
}

extension View {
  /// Runs a chosen action: seeds the create bar, or opens the picker or frame grabber the action needs.
  func turnIntoFlow(request: Binding<TurnIntoRequest?>, context: StudioEditContext?) -> some View {
    modifier(TurnIntoFlow(request: request, context: context))
  }
}

private struct TurnIntoFlow: ViewModifier {
  @Binding var request: TurnIntoRequest?
  let context: StudioEditContext?
  @State private var picking: MediaItem?
  @State private var grabbing: MediaItem?
  @State private var grabbed: MediaItem?
  @State private var editing: MediaItem?

  func body(content: Content) -> some View {
    content
      .onChange(of: request?.id) {
        guard let request, let context else { return }
        self.request = nil
        switch request.action {
        case .animate, .arriveAt:
          if let seed = TurnInto.seed(request.action, from: request.item, current: context.currentInputs()) {
            context.apply(seed)
          }
        case .morph: picking = request.item
        case .grabFrame: grabbing = request.item
        }
      }
      .sheet(item: $picking) { source in
        if let context {
          MorphPickerView(source: source, media: context.media) { second in
            if let seed = TurnInto.seed(.morph, from: source, secondImage: second, current: context.currentInputs()) {
              context.apply(seed)
            }
          }
        }
      }
      .sheet(
        item: $grabbing,
        onDismiss: {
          editing = grabbed; grabbed = nil
        }
      ) { video in
        if let context {
          FrameGrabView(video: video, uploader: context.frames) { grabbed = $0 }
        }
      }
      .fullScreenCover(item: $editing) { frame in
        if let context {
          RegionEditView(item: frame, api: context.api, media: context.media, tracker: context.tracker)
        }
      }
  }
}

/// Pick the image a morph ends on.
private struct MorphPickerView: View {
  let source: MediaItem
  let media: any MediaAPI
  let onPick: (MediaItem) -> Void
  @State private var images: [MediaItem] = []
  @State private var failed = false
  @Environment(\.dismiss) private var dismiss

  private let columns = [GridItem(.adaptive(minimum: 100), spacing: 2)]

  var body: some View {
    NavigationStack {
      ScrollView {
        if failed {
          ContentUnavailableView("Couldn't load images", systemImage: "wifi.exclamationmark")
        } else if images.isEmpty {
          ProgressView().padding(.top, 40)
        }
        LazyVGrid(columns: columns, spacing: 2) {
          ForEach(images) { image in
            Button {
              onPick(image)
              dismiss()
            } label: {
              Color.clear.aspectRatio(1, contentMode: .fit)
                .overlay {
                  AsyncImage(url: image.url) { phase in
                    if let loaded = phase.image {
                      loaded.resizable().scaledToFill()
                    } else {
                      Tokens.Palette.groupedBackground
                    }
                  }
                }
                .clipped()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(image.displayTitle)
            .accessibilityIdentifier("morph-pick-\(image.id)")
          }
        }
      }
      .navigationTitle("Morph into...")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
      .task {
        do {
          let page = try await media.listMedia(kind: .image, page: 1, limit: 60)
          images = page.items.filter { $0.id != source.id }
        } catch {
          failed = true
        }
      }
    }
  }
}

/// Scrub a video, pick a frame, upload it as an image.
private struct FrameGrabView: View {
  let video: MediaItem
  let uploader: FrameUploader
  let onGrabbed: (MediaItem) -> Void

  @State private var duration: Double = 0
  @State private var position: Double = 0
  @State private var frame: UIImage?
  @State private var isUploading = false
  @State private var message: String?
  @State private var asset: AVURLAsset?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(spacing: Tokens.Spacing.m) {
        ZStack {
          Color.black
          if let frame {
            Image(uiImage: frame).resizable().scaledToFit()
          } else {
            ProgressView().tint(.white)
          }
        }
        .frame(maxHeight: .infinity)
        if duration > 0 {
          Slider(value: $position, in: 0...duration)
            .accessibilityLabel("Frame position")
            .accessibilityIdentifier("frame-grab-slider")
            .padding(.horizontal, Tokens.Spacing.m)
        }
        if let message {
          Text(message)
            .font(Tokens.Typography.meta)
            .foregroundStyle(Tokens.Palette.destructive)
            .accessibilityIdentifier("frame-grab-error")
        }
        Button {
          Task { await upload() }
        } label: {
          Group {
            if isUploading { ProgressView() } else { Text("Use this frame") }
          }
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(frame == nil || isUploading)
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.bottom, Tokens.Spacing.m)
        .accessibilityIdentifier("frame-grab-use")
      }
      .navigationTitle("Grab a frame")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
      .task { await prepare() }
      .task(id: position) { await render() }
    }
  }

  private func prepare() async {
    guard let url = video.url else {
      message = "This video isn't ready yet."
      return
    }
    let asset = AVURLAsset(url: url)
    do {
      let length = try await asset.load(.duration).seconds
      guard length.isFinite, length > 0 else { throw APIError.malformedResponse }
      self.asset = asset
      duration = length
      await render()
    } catch {
      message = "Couldn't read this video."
    }
  }

  private func render() async {
    guard let asset else { return }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    do {
      let time = CMTime(seconds: min(position, max(duration - 0.05, 0)), preferredTimescale: 600)
      frame = UIImage(cgImage: try await generator.image(at: time).image)
    } catch is CancellationError {
      return
    } catch {
      message = "Couldn't read that frame."
    }
  }

  private func upload() async {
    guard let frame, let data = frame.jpegData(compressionQuality: 0.92) else { return }
    isUploading = true
    message = nil
    defer { isUploading = false }
    do {
      let item = try await uploader.upload(
        jpeg: data, fileName: "\(video.displayTitle)-frame.jpg")
      onGrabbed(item)
      dismiss()
    } catch FrameUploadError.blocked {
      message = "This frame was blocked by the content scan."
    } catch FrameUploadError.notReady {
      message = "The frame is still being checked. Try again in a moment."
    } catch {
      message = "Couldn't upload this frame. Check your connection and try again."
    }
  }
}
