import B4MKit
import SwiftUI
import UIKit

/// Draw boxes on an image with a finger, say what should change in each, and send it as one region edit.
/// The edit runs in the background; its tile shows up in Studio and the result lands in the gallery.
struct RegionEditView: View {
  @State private var model: RegionEditViewModel
  @State private var image: UIImage?
  @State private var loadFailed = false
  @State private var dragRect: CGRect?
  @FocusState private var focusedRegion: UUID?
  @Environment(\.dismiss) private var dismiss

  init(item: MediaItem, api: any StudioAPI, media: any MediaAPI, tracker: GenerationTracker) {
    _model = State(initialValue: RegionEditViewModel(item: item, api: api, media: media, tracker: tracker))
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        canvas
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color.black)
        regionList
      }
      .navigationTitle("Edit regions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .accessibilityIdentifier("region-edit-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.isSubmitting {
            ProgressView()
          } else {
            Button("Edit") {
              Task { if await model.submit() { dismiss() } }
            }
            .disabled(!model.canSubmit)
            .accessibilityIdentifier("region-edit-submit")
          }
        }
      }
      .task { await loadImage() }
    }
  }

  // MARK: Canvas

  @ViewBuilder
  private var canvas: some View {
    if let image {
      GeometryReader { proxy in
        let frame = RegionGeometry.fittedFrame(imageSize: image.size, in: proxy.size)
        ZStack(alignment: .topLeading) {
          Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(width: proxy.size.width, height: proxy.size.height)
          ForEach(Array(model.regions.enumerated()), id: \.element.id) { index, region in
            regionBox(index: index, region: region, frame: frame)
          }
          if let dragRect {
            Rectangle()
              .strokeBorder(Color.white, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
              .frame(width: dragRect.width, height: dragRect.height)
              .offset(x: dragRect.minX, y: dragRect.minY)
              .allowsHitTesting(false)
          }
        }
        .contentShape(Rectangle())
        .gesture(drawGesture(imageFrame: frame))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Image. Drag to mark an area to change.")
        .accessibilityIdentifier("region-edit-canvas")
      }
    } else if loadFailed {
      ContentUnavailableView {
        Label("Couldn't load this image", systemImage: "photo")
      } actions: {
        Button("Try Again") { Task { await loadImage() } }.buttonStyle(.borderedProminent)
      }
      .environment(\.colorScheme, .dark)
    } else {
      ProgressView().tint(.white)
    }
  }

  private func regionBox(index: Int, region: EditRegion, frame: CGRect) -> some View {
    let rect = RegionGeometry.viewRect(region.rect, imageFrame: frame)
    let selected = model.selectedRegionID == region.id
    return Rectangle()
      .strokeBorder(selected ? Tokens.Palette.brand : Color.white, lineWidth: selected ? 3 : 2)
      .background(Color.white.opacity(0.08))
      .overlay(alignment: .topLeading) {
        Text("\(index + 1)")
          .font(.caption.weight(.bold))
          .foregroundStyle(.white)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(selected ? Tokens.Palette.brand : Color.black.opacity(0.6))
      }
      .frame(width: rect.width, height: rect.height)
      .offset(x: rect.minX, y: rect.minY)
      .onTapGesture {
        model.selectedRegionID = region.id
        focusedRegion = region.id
      }
      .accessibilityLabel("Region \(index + 1)")
  }

  private func drawGesture(imageFrame: CGRect) -> some Gesture {
    DragGesture(minimumDistance: 8, coordinateSpace: .local)
      .onChanged { value in
        guard model.canAddRegion else { return }
        dragRect = CGRect(
          x: min(value.startLocation.x, value.location.x), y: min(value.startLocation.y, value.location.y),
          width: abs(value.location.x - value.startLocation.x), height: abs(value.location.y - value.startLocation.y))
      }
      .onEnded { _ in
        defer { dragRect = nil }
        guard let dragRect, let normalized = RegionGeometry.normalized(dragRect, imageFrame: imageFrame),
          let region = model.addRegion(normalized)
        else { return }
        focusedRegion = region.id
      }
  }

  // MARK: Regions

  private var regionList: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
      if model.regions.isEmpty {
        Label("Drag on the image to mark an area to change.", systemImage: "hand.draw")
          .font(Tokens.Typography.meta)
          .foregroundStyle(Tokens.Palette.secondaryText)
      } else {
        ScrollView {
          VStack(spacing: Tokens.Spacing.s) {
            ForEach(Array(model.regions.enumerated()), id: \.element.id) { index, region in
              regionRow(index: index, region: region)
            }
          }
        }
        .frame(maxHeight: 220)
        if !model.canAddRegion {
          Text("You can mark up to \(RegionGeometry.maximumRegions) areas.")
            .font(Tokens.Typography.meta)
            .foregroundStyle(Tokens.Palette.secondaryText)
        }
      }
      if let error = model.error {
        Text(error.message)
          .font(Tokens.Typography.meta)
          .foregroundStyle(Tokens.Palette.destructive)
          .accessibilityIdentifier("region-edit-error")
      }
      Picker("Model", selection: $model.modelID) {
        ForEach(GenerationModel.regionEditModels) { option in Text(option.name).tag(option.id) }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("region-edit-model")
    }
    .padding(Tokens.Spacing.m)
    .background(.bar)
  }

  private func regionRow(index: Int, region: EditRegion) -> some View {
    HStack(spacing: Tokens.Spacing.s) {
      Text("\(index + 1)")
        .font(.caption.weight(.bold))
        .frame(width: 24, height: 24)
        .background(Tokens.Palette.groupedBackground, in: Circle())
      TextField(
        "What should change here?",
        text: Binding(get: { region.prompt }, set: { model.setPrompt($0, for: region.id) })
      )
      .focused($focusedRegion, equals: region.id)
      .textFieldStyle(.roundedBorder)
      .accessibilityIdentifier("region-edit-prompt-\(index + 1)")
      Button(role: .destructive) {
        model.removeRegion(region.id)
      } label: {
        Image(systemName: "trash")
      }
      .frame(minWidth: 44, minHeight: 44)
      .accessibilityLabel("Remove region \(index + 1)")
    }
  }

  // MARK: Loading

  /// Loads the bytes once so the box geometry knows the image's real aspect ratio.
  private func loadImage() async {
    loadFailed = false
    guard let url = model.item.url else {
      loadFailed = true
      return
    }
    do {
      let (data, _) = try await URLSession.shared.data(from: url)
      guard let loaded = UIImage(data: data) else { throw URLError(.cannotDecodeContentData) }
      image = loaded
    } catch {
      loadFailed = true
    }
  }
}
