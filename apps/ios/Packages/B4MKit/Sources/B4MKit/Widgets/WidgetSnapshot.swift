import Foundation

/// The app group shared by the app and its widget extension. Must match both entitlements files.
public enum AppGroup {
  public static let identifier = "group.com.bike4mind.app"
}

/// What the widgets show, written by the app and read by the widget extension.
///
/// Deliberate v1 design: the widget process never touches the network or the auth session. The app
/// writes this small snapshot into the shared app-group container at natural moments (a chat turn
/// settling, a credits fetch, a media fetch) and asks WidgetKit to reload. Every field is optional
/// because the app only knows what it has fetched so far.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
  /// Bumped when the shape changes incompatibly; a reader ignores a snapshot it cannot understand.
  public static let currentSchemaVersion = 1

  public struct RunningAgents: Codable, Equatable, Sendable {
    public struct Top: Codable, Equatable, Sendable {
      public let sessionID: String
      public let title: String
      public let status: String

      public init(sessionID: String, title: String, status: String) {
        self.sessionID = sessionID
        self.title = title
        self.status = status
      }
    }

    public let count: Int
    public let top: Top?
    public let observedAt: Date

    public init(count: Int, top: Top?, observedAt: Date) {
      self.count = count
      self.top = top
      self.observedAt = observedAt
    }
  }

  public struct Credits: Codable, Equatable, Sendable {
    public let balance: Double
    public let observedAt: Date

    public init(balance: Double, observedAt: Date) {
      self.balance = balance
      self.observedAt = observedAt
    }
  }

  public struct LatestGeneration: Codable, Equatable, Sendable {
    public let mediaID: String
    public let title: String
    public let createdAt: Date
    /// File name inside the store's thumbnail directory; `nil` when the thumbnail could not be saved.
    public let thumbnailFileName: String?

    public init(mediaID: String, title: String, createdAt: Date, thumbnailFileName: String?) {
      self.mediaID = mediaID
      self.title = title
      self.createdAt = createdAt
      self.thumbnailFileName = thumbnailFileName
    }
  }

  public var schemaVersion: Int
  public var runningAgents: RunningAgents?
  public var credits: Credits?
  public var latestGeneration: LatestGeneration?

  public init(
    schemaVersion: Int = WidgetSnapshot.currentSchemaVersion,
    runningAgents: RunningAgents? = nil,
    credits: Credits? = nil,
    latestGeneration: LatestGeneration? = nil
  ) {
    self.schemaVersion = schemaVersion
    self.runningAgents = runningAgents
    self.credits = credits
    self.latestGeneration = latestGeneration
  }

  public static let empty = WidgetSnapshot()
}

/// The widget kinds the app asks WidgetKit to reload. The extension declares the same strings.
public enum WidgetKind {
  public static let runningAgents = "com.bike4mind.widget.running-agents"
  public static let credits = "com.bike4mind.widget.credits"
  public static let latestGeneration = "com.bike4mind.widget.latest-generation"

  public static let all = [runningAgents, credits, latestGeneration]
}
