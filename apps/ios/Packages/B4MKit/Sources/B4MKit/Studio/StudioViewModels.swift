import CoreGraphics
import Foundation
import Observation

/// Why a create or edit request did not start.
public enum StudioSubmitError: Error, Equatable, Sendable {
  /// The server refused it with a reason the person can act on (credits, model, content).
  case refused(GenerationFailure)
  /// The server refused a value with its own reason (an `unsupported_*` or validation code). The reason is shown as
  /// sent, so the wording matches the web app.
  case rejected(code: String?, message: String)
  case api(APIError)

  init(_ error: any Error) {
    switch error {
    case let refusal as StudioRequestError:
      if case .other = refusal.failure, let message = refusal.serverMessage, !message.isEmpty {
        self = .rejected(code: refusal.code, message: message)
      } else {
        self = .refused(refusal.failure)
      }
    case let api as APIError: self = .api(api)
    default: self = .api(.malformedResponse)
    }
  }
}

/// The create bar: pick a kind and a model, type a prompt, generate.
@MainActor
@Observable
public final class StudioCreateViewModel {
  /// The video and music routes cap prompts at this length; the image routes accept the same.
  public static let maximumPromptLength = 4000

  public var kind: GenerationKind = .image {
    didSet { paramsNote = nil }
  }
  public var prompt = ""
  public private(set) var models: [GenerationKind: [GenerationModel]] = [:]
  /// Changed values per kind, kept while switching kinds so nothing is lost.
  public private(set) var paramsByKind: [GenerationKind: GenerationParams] = [:]
  /// Names the values a model switch had to drop; cleared on the next change.
  public private(set) var paramsNote: String?
  public private(set) var isSubmitting = false
  public var error: StudioSubmitError?

  @ObservationIgnored private var selectedModelIDs: [GenerationKind: String] = [:]
  @ObservationIgnored private let api: any StudioAPI
  @ObservationIgnored private let tracker: GenerationTracker

  public init(api: any StudioAPI, tracker: GenerationTracker) {
    self.api = api
    self.tracker = tracker
  }

  public var availableModels: [GenerationModel] { models[kind] ?? [] }

  public var selectedModel: GenerationModel? {
    let list = availableModels
    return list.first { $0.id == selectedModelIDs[kind] } ?? list.first
  }

  /// Switches model, keeping the values the new one also takes and naming the ones it doesn't.
  public func select(model: GenerationModel) {
    let previousControls = controls
    let (kept, dropped) = params.carried(to: model.capabilities)
    selectedModelIDs[kind] = model.id
    paramsByKind[kind] = kept
    let names = dropped.compactMap { key in previousControls.first { $0.key == key }?.title }
    paramsNote = names.isEmpty ? nil : "\(model.name) doesn't take \(Self.list(names)), so it was reset."
  }

  public var params: GenerationParams { paramsByKind[kind] ?? GenerationParams() }

  /// The panel's controls for the selected model, in display order.
  public var controls: [ParamControl] {
    ParamControls.controls(for: selectedModel?.capabilities, params: params)
  }

  public func value(for control: ParamControl) -> ParamValue? { params.value(for: control) }

  public func set(_ value: ParamValue?, for control: ParamControl) {
    var updated = params
    updated.set(value, for: control)
    if control.key == .instrumental, value?.flag == true { updated[.lyrics] = nil }
    paramsByKind[kind] = updated
    paramsNote = nil
  }

  public func resetParams() {
    paramsByKind[kind] = nil
    paramsNote = nil
  }

  /// The summary chip: the changed values, or nil when everything is the model default.
  public var paramsSummary: String? { params.summary(controls: controls) }

  /// Credits the selected settings should cost, when the model list prices them.
  public var estimatedCredits: Int? { CreditEstimate.credits(for: selectedModel?.capabilities, params: params) }

  /// "Use these settings" from a finished item: its kind, model and values, with the same carry-over rules as a
  /// model switch so a model since removed falls back cleanly. Its prompt fills the bar only when nothing is typed.
  public func use(settingsOf handle: GenerationHandle) async {
    kind = handle.kind
    await loadModels()
    let original = handle.modelID.flatMap { id in availableModels.first { $0.id == id } }
    if let original { selectedModelIDs[kind] = original.id }
    let (kept, dropped) = (handle.params ?? GenerationParams()).carried(to: selectedModel?.capabilities)
    paramsByKind[kind] = kept
    let current = selectedModel?.name ?? "this model"
    var notes: [String] = []
    if original == nil { notes.append("The original model isn't available, so this uses \(current).") }
    if !dropped.isEmpty { notes.append("Some settings aren't available on \(current).") }
    paramsNote = notes.isEmpty ? nil : notes.joined(separator: " ")
    if trimmedPrompt.isEmpty { prompt = handle.prompt }
  }

  /// What a generation was made with, for its tile: the changed values against its model's controls.
  public func summary(of handle: GenerationHandle) -> String? {
    guard let params = handle.params, !params.isEmpty else { return nil }
    let capabilities = models[handle.kind]?.first { $0.id == handle.modelID }?.capabilities
    return params.summary(controls: ParamControls.controls(for: capabilities, params: params))
  }

  static func list(_ names: [String]) -> String {
    let lowered = names.map { $0.lowercased() }
    guard lowered.count > 1, let last = lowered.last else { return lowered.first ?? "" }
    return lowered.dropLast().joined(separator: ", ") + " or " + last
  }

  private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }

  public var canSubmit: Bool {
    !isSubmitting && selectedModel != nil && !trimmedPrompt.isEmpty
      && trimmedPrompt.count <= Self.maximumPromptLength
  }

  /// Loads the model list for the current kind once. A failed load falls back to a known model where one exists,
  /// so the bar still works offline-first; video and music have no safe default and stay disabled.
  public func loadModels() async {
    let kind = kind
    guard models[kind] == nil else { return }
    do {
      let loaded = try await api.models(for: kind)
      models[kind] = loaded.isEmpty ? GenerationModel.fallback(for: kind).map { [$0] } ?? [] : loaded
    } catch {
      if let fallback = GenerationModel.fallback(for: kind) { models[kind] = [fallback] }
    }
  }

  /// Starts the generation and hands it to the tracker. Returns whether it started.
  @discardableResult
  public func submit() async -> Bool {
    guard canSubmit, let model = selectedModel else { return false }
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      let handle = try await api.generate(
        GenerationRequest(kind: kind, prompt: trimmedPrompt, modelID: model.id, params: params))
      tracker.track(handle)
      prompt = ""
      return true
    } catch {
      self.error = StudioSubmitError(error)
      return false
    }
  }
}

/// Drawing boxes on an image and describing what to change in each.
@MainActor
@Observable
public final class RegionEditViewModel {
  public let item: MediaItem
  public private(set) var regions: [EditRegion] = []
  public var selectedRegionID: UUID?
  public var modelID = GenerationModel.regionEditModels[0].id
  public private(set) var isSubmitting = false
  public var error: StudioSubmitError?

  /// The notebook edits go to when the image names none.
  static let fallbackSessionName = "Studio edits"

  @ObservationIgnored private let api: any StudioAPI
  @ObservationIgnored private let media: any MediaAPI
  @ObservationIgnored private let tracker: GenerationTracker

  public init(item: MediaItem, api: any StudioAPI, media: any MediaAPI, tracker: GenerationTracker) {
    self.item = item
    self.api = api
    self.media = media
    self.tracker = tracker
  }

  public var canAddRegion: Bool { regions.count < RegionGeometry.maximumRegions }

  public var canSubmit: Bool {
    !isSubmitting && !regions.isEmpty
      && regions.allSatisfy { !$0.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  /// Adds a normalised box and selects it so its prompt field takes focus.
  @discardableResult
  public func addRegion(_ rect: CGRect) -> EditRegion? {
    guard canAddRegion else { return nil }
    let region = EditRegion(rect: rect)
    regions.append(region)
    selectedRegionID = region.id
    return region
  }

  public func setPrompt(_ prompt: String, for id: UUID) {
    guard let index = regions.firstIndex(where: { $0.id == id }) else { return }
    regions[index].prompt = prompt
  }

  public func removeRegion(_ id: UUID) {
    regions.removeAll { $0.id == id }
    if selectedRegionID == id { selectedRegionID = regions.last?.id }
  }

  /// Starts the edit. Re-signs the source URL first: the server reads it when the render runs, and a gallery URL
  /// may be close to expiring.
  @discardableResult
  public func submit() async -> Bool {
    guard canSubmit else { return false }
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      let fresh = try await media.media(id: item.id)
      guard let url = fresh.url else { throw APIError.notFound }
      let sessionID: String
      if let existing = fresh.sessionID ?? item.sessionID {
        sessionID = existing
      } else {
        sessionID = try await api.createSession(name: Self.fallbackSessionName)
      }
      let handle = try await api.editImage(
        ImageEditRequest(imageURL: url, sessionID: sessionID, modelID: modelID, regions: regions))
      tracker.track(handle)
      return true
    } catch {
      self.error = StudioSubmitError(error)
      return false
    }
  }
}
