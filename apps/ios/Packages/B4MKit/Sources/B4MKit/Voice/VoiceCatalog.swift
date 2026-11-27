import Foundation
import Observation

/// Whose voice selection is being read: a selection made on one account or server never carries to another.
public struct VoiceAccount: Hashable, Sendable {
  public let userID: String
  public let host: String

  public init(userID: String, baseURL: URL) {
    self.userID = userID
    host = baseURL.host()?.lowercased() ?? baseURL.absoluteString
  }
}

public struct VoiceSelection: Codable, Equatable, Sendable {
  public let id: String
  public let name: String

  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// The premium voice picked on this device. Kept on the device only: the server's `preferredVoice` is the web
/// app's setting and may name a voice from another provider.
public protocol VoiceSelectionStore: AnyObject, Sendable {
  func selection(for account: VoiceAccount) -> VoiceSelection?
  func setSelection(_ selection: VoiceSelection?, for account: VoiceAccount)
}

public final class UserDefaultsVoiceSelectionStore: VoiceSelectionStore, @unchecked Sendable {
  private let defaults: UserDefaults
  private static let prefix = "b4m.voiceSelection."

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func selection(for account: VoiceAccount) -> VoiceSelection? {
    guard let data = defaults.data(forKey: Self.key(account)) else { return nil }
    return try? JSONDecoder().decode(VoiceSelection.self, from: data)
  }

  public func setSelection(_ selection: VoiceSelection?, for account: VoiceAccount) {
    guard let selection, let data = try? JSONEncoder().encode(selection) else {
      defaults.removeObject(forKey: Self.key(account))
      return
    }
    defaults.set(data, forKey: Self.key(account))
  }

  private static func key(_ account: VoiceAccount) -> String {
    "\(prefix)\(account.host)|\(account.userID)"
  }
}

/// The deployment's premium voice catalog and this device's pick from it. Nothing here ever surfaces an
/// error: a switched-off, unconfigured or unreachable catalog only means replies use on-device speech.
@MainActor
@Observable
public final class VoiceCatalogModel {
  public enum State: Equatable, Sendable {
    case idle
    case loading
    /// The deployment has premium voices switched off or unconfigured. Settings hides the voice row.
    case unavailable
    case loaded([VoiceOption])
    case failed(Failure)
  }

  public enum Failure: Equatable, Sendable {
    case offline
    case server
  }

  public private(set) var state: State = .idle
  public private(set) var selection: VoiceSelection?

  @ObservationIgnored private let wire: any VoiceAPI
  @ObservationIgnored private let store: any VoiceSelectionStore
  @ObservationIgnored private let currentAccount: @MainActor () async -> VoiceAccount?
  @ObservationIgnored private let premiumVoiceWait: Duration
  @ObservationIgnored private var account: VoiceAccount?
  /// The last flag reading and catalog this app session saw; a later failed load keeps them.
  private var flagEnabled: Bool?
  @ObservationIgnored private var lastCatalog: [VoiceOption]?
  @ObservationIgnored private var inFlight: Task<Void, Never>?
  /// Bumped by `reset()`, so a load that lands after sign-out is dropped.
  @ObservationIgnored private var generation = 0

  public init(
    wire: any VoiceAPI, store: any VoiceSelectionStore,
    currentAccount: @escaping @MainActor () async -> VoiceAccount?,
    premiumVoiceWait: Duration = .seconds(3)
  ) {
    self.wire = wire
    self.store = store
    self.currentAccount = currentAccount
    self.premiumVoiceWait = premiumVoiceWait
  }

  /// Fetches the flag and the catalog. Concurrent callers share one fetch.
  public func load() async {
    if let inFlight { return await inFlight.value }
    let started = generation
    let task = Task { await performLoad(generation: started) }
    inFlight = task
    await task.value
    if started == generation { inFlight = nil }
  }

  /// Whether Settings offers the voice picker: the deployment has premium voices on, even if the last catalog
  /// fetch failed. Stays true through a refetch so the row does not flicker.
  public var offersVoices: Bool { flagEnabled == true && state != .unavailable }

  /// Picks a premium voice for this account, or `nil` for on-device speech.
  public func select(_ voice: VoiceOption?) {
    let picked = voice.map { VoiceSelection(id: $0.id, name: $0.name) }
    selection = picked
    if let account { store.setSelection(picked, for: account) }
  }

  /// The voice id replies should be spoken in, or `nil` for on-device speech. With no stored pick it answers
  /// without the network. Otherwise it loads the catalog (or joins a running load) for at most `premiumVoiceWait`;
  /// past that the conversation starts on-device and the load finishes in the background.
  public func premiumVoice() async -> String? {
    var flagUnread = false
    if case .failed = state, flagEnabled == nil { flagUnread = true }
    if state == .idle || state == .loading || flagUnread {
      guard let account = await currentAccount(), store.selection(for: account) != nil else { return nil }
      guard await loadFinished(within: premiumVoiceWait) else { return nil }
    }
    guard flagEnabled == true, let selection else { return nil }
    switch state {
    case .loaded, .failed:
      // A failed refresh keeps the last catalog; with none seen yet the speaker's own fallback covers a bad id.
      let inCatalog = lastCatalog?.contains { $0.id == selection.id } ?? true
      return inCatalog ? selection.id : nil
    case .idle, .loading, .unavailable:
      return nil
    }
  }

  /// Drops the cached catalog and in-memory pick (sign-out, session expiry or server switch). Stored picks stay:
  /// they are keyed per account and server, so the next account never reads them and the same one gets its pick back.
  public func reset() {
    generation += 1
    inFlight?.cancel()
    inFlight = nil
    state = .idle
    selection = nil
    account = nil
    flagEnabled = nil
    lastCatalog = nil
  }

  private func loadFinished(within limit: Duration) async -> Bool {
    let race = LoadRace()
    return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      race.timer = Task {
        try? await Task.sleep(for: limit)
        race.finish(false, continuation)
      }
      Task {
        await load()
        race.timer?.cancel()
        race.finish(true, continuation)
      }
    }
  }

  private func performLoad(generation started: Int) async {
    state = .loading
    let resolved = await currentAccount()
    guard started == generation else { return }
    account = resolved
    selection = resolved.flatMap { store.selection(for: $0) }

    let outcome: State
    do {
      let enabled = try await wire.voiceSessionsEnabled()
      guard started == generation else { return }
      flagEnabled = enabled
      if enabled {
        let voices = try await wire.listVoices()
        guard started == generation else { return }
        lastCatalog = voices
        outcome = .loaded(voices)
      } else {
        outcome = .unavailable
      }
    } catch VoiceWireError.unavailable {
      outcome = .unavailable
    } catch VoiceWireError.offline {
      outcome = .failed(.offline)
    } catch is CancellationError {
      outcome = .idle
    } catch {
      outcome = .failed(.server)
    }
    guard started == generation else { return }
    state = outcome
    pruneSelection()
  }

  /// A voice removed from the workspace is forgotten, so replies go back to on-device speech.
  private func pruneSelection() {
    guard case .loaded(let voices) = state, let current = selection, !voices.contains(where: { $0.id == current.id })
    else { return }
    select(nil)
  }
}

/// Resumes `loadFinished`'s continuation once, from whichever of the load or the timer ends first.
@MainActor
private final class LoadRace {
  var timer: Task<Void, Never>?
  private var finished = false

  func finish(_ loaded: Bool, _ continuation: CheckedContinuation<Bool, Never>) {
    guard !finished else { return }
    finished = true
    continuation.resume(returning: loaded)
  }
}
