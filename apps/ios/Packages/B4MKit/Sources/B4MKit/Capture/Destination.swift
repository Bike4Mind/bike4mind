import Foundation
import os

/// Where a capture lands. Names are carried so the composer can show the last choice without a fetch.
public enum CaptureDestination: Hashable, Sendable, Codable, Identifiable {
  case lake(id: String, name: String)
  case session(id: String, name: String)

  public var id: String {
    switch self {
    case .lake(let id, _): "lake:\(id)"
    case .session(let id, _): "session:\(id)"
    }
  }

  public var name: String {
    switch self {
    case .lake(_, let name), .session(_, let name): name
    }
  }

  public var isLake: Bool {
    if case .lake = self { true } else { false }
  }
}

/// Remembers the last destination so the next share starts where the previous one ended.
public protocol DestinationStore: Sendable {
  func lastDestination() -> CaptureDestination?
  func remember(_ destination: CaptureDestination)
  func forget()
}

public struct UserDefaultsDestinationStore: DestinationStore {
  private static let key = "b4m.capture.lastDestination"
  // UserDefaults is documented thread-safe; the box only satisfies Sendable checking.
  private let box: DefaultsBox

  public init(defaults: UserDefaults = SharedContainer.defaults()) {
    box = DefaultsBox(defaults: defaults)
  }

  public func lastDestination() -> CaptureDestination? {
    guard let data = box.defaults.data(forKey: Self.key) else { return nil }
    return try? JSONDecoder().decode(CaptureDestination.self, from: data)
  }

  public func remember(_ destination: CaptureDestination) {
    guard let data = try? JSONEncoder().encode(destination) else { return }
    box.defaults.set(data, forKey: Self.key)
  }

  public func forget() {
    box.defaults.removeObject(forKey: Self.key)
  }

  private struct DefaultsBox: @unchecked Sendable {
    let defaults: UserDefaults
  }
}

public final class InMemoryDestinationStore: DestinationStore {
  private let storage: OSAllocatedUnfairLock<CaptureDestination?>

  public init(_ initial: CaptureDestination? = nil) {
    storage = OSAllocatedUnfairLock(initialState: initial)
  }

  public func lastDestination() -> CaptureDestination? { storage.withLock { $0 } }
  public func remember(_ destination: CaptureDestination) { storage.withLock { $0 = destination } }
  public func forget() { storage.withLock { $0 = nil } }
}
