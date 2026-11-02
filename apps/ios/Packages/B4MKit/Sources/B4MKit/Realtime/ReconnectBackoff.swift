import Foundation

/// Reconnect schedule, matching the web client: `125 * (attempt + 1)^2` ms plus up to 1s of jitter so a
/// fleet of clients dropped by one gateway blip does not reconnect in lockstep.
public struct ReconnectBackoff: Sendable {
  /// After this many consecutive failures the client stops until the app returns to the foreground.
  public let maxAttempts: Int
  private let jitter: @Sendable () -> Double

  /// - Parameter jitter: a value in `0...1`; injectable so tests get exact delays.
  public init(maxAttempts: Int = 20, jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }) {
    self.maxAttempts = maxAttempts
    self.jitter = jitter
  }

  /// Delay before reconnect attempt `attempt` (zero-based), or `nil` once attempts are exhausted.
  public func delay(forAttempt attempt: Int) -> Duration? {
    guard attempt < maxAttempts else { return nil }
    let base = 125 * (attempt + 1) * (attempt + 1)
    let jitterMilliseconds = Int((min(max(jitter(), 0), 1) * 1000).rounded())
    return .milliseconds(base + jitterMilliseconds)
  }
}
