import Foundation
import Observation

/// Drives the "don't notify me after a busy block" toggles in Settings > Notifications. Each change saves at once
/// and rolls back if the server refuses it.
@MainActor
@Observable
public final class InterruptionFeedbackViewModel {
  public private(set) var feedback = InterruptionFeedback()
  public private(set) var isLoaded = false
  public private(set) var isSaving = false
  public private(set) var errorMessage: String?

  @ObservationIgnored private let api: any InterruptionFeedbackAPI

  public init(api: any InterruptionFeedbackAPI) {
    self.api = api
  }

  public func isQuiet(_ category: InterruptionCategory) -> Bool {
    feedback[category] ?? false
  }

  public func load() async {
    do {
      feedback = try await api.feedback()
      isLoaded = true
      errorMessage = nil
    } catch {
      errorMessage = "Couldn't load your after-meeting notification setting. Try again later."
    }
  }

  public func setQuiet(_ category: InterruptionCategory, _ isOn: Bool) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    errorMessage = nil
    let previous = feedback
    feedback[category] = isOn
    var patch = InterruptionFeedback()
    patch[category] = isOn
    do {
      feedback = try await api.save(patch)
    } catch {
      feedback = previous
      errorMessage = "Couldn't save your after-meeting notification setting. Try again."
    }
  }
}
