import B4MKit
import SwiftUI

/// Studio's bottom bar: Image / Video / Music, a model menu, a prompt and Generate.
struct StudioCreateBar: View {
  @Bindable var model: StudioCreateViewModel
  @FocusState private var isFocused: Bool
  @ScaledMetric(relativeTo: .title) private var iconSize: CGFloat = 32

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
      HStack(spacing: Tokens.Spacing.s) {
        Picker("Create", selection: $model.kind) {
          ForEach(GenerationKind.allCases, id: \.self) { kind in Text(kind.title).tag(kind) }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 260)
        .accessibilityIdentifier("studio-create-kind")
        Spacer(minLength: 0)
        modelMenu
      }
      if model.kind == .music {
        Toggle("Instrumental", isOn: $model.instrumental)
          .font(Tokens.Typography.meta)
          .accessibilityIdentifier("studio-create-instrumental")
      }
      if let error = model.error {
        Text(error.message)
          .font(Tokens.Typography.meta)
          .foregroundStyle(Tokens.Palette.destructive)
          .accessibilityIdentifier("studio-create-error")
      }
      HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
        promptField
        generateButton
      }
    }
    .padding(.horizontal, Tokens.Spacing.m)
    .padding(.vertical, Tokens.Spacing.s)
    .background(.bar)
    .task(id: model.kind) { await model.loadModels() }
  }

  @ViewBuilder
  private var modelMenu: some View {
    if let selected = model.selectedModel {
      Menu {
        ForEach(model.availableModels) { option in
          Button {
            model.select(model: option)
          } label: {
            if option.id == selected.id { Label(option.name, systemImage: "checkmark") } else { Text(option.name) }
          }
        }
      } label: {
        Label(selected.name, systemImage: "chevron.up.chevron.down")
          .labelStyle(.titleAndIcon)
          .font(Tokens.Typography.meta)
          .lineLimit(1)
      }
      .frame(minHeight: 44)
      .accessibilityLabel("Model, \(selected.name)")
      .accessibilityIdentifier("studio-create-model")
    } else {
      ProgressView().frame(minWidth: 44, minHeight: 44)
    }
  }

  private var promptField: some View {
    TextField(placeholder, text: $model.prompt, axis: .vertical)
      .lineLimit(1...5)
      .focused($isFocused)
      .padding(.horizontal, Tokens.Spacing.m)
      .padding(.vertical, Tokens.Spacing.s + 2)
      .background(Tokens.Palette.groupedBackground)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
          .strokeBorder(Tokens.Palette.divider, lineWidth: 1)
      }
      .accessibilityIdentifier("studio-create-prompt")
  }

  private var placeholder: String {
    switch model.kind {
    case .image: "Describe an image"
    case .video: "Describe a video"
    case .music: "Describe a song"
    }
  }

  private var generateButton: some View {
    Button {
      Task {
        if await model.submit() { isFocused = false }
      }
    } label: {
      Group {
        if model.isSubmitting {
          ProgressView()
        } else {
          Image(systemName: "sparkles")
            .font(.system(size: iconSize * 0.6, weight: .semibold))
        }
      }
      .frame(width: iconSize, height: iconSize)
      .background(model.canSubmit ? Tokens.Palette.brand : Tokens.Palette.divider, in: Circle())
      .foregroundStyle(.white)
    }
    .disabled(!model.canSubmit)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Generate \(model.kind.title.lowercased())")
    .accessibilityIdentifier("studio-create-generate")
  }
}

extension StudioSubmitError {
  var message: String {
    switch self {
    case .refused(let failure): failure.message
    case .api(let error): error.message
    }
  }
}
