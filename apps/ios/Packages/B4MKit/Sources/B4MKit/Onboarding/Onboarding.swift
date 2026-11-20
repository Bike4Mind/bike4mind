import Foundation

/// One screen of the first-launch welcome.
public struct OnboardingPage: Equatable, Sendable, Identifiable {
  public let id: String
  public let systemImage: String
  public let title: String
  public let message: String

  public init(id: String, systemImage: String, title: String, message: String) {
    self.id = id
    self.systemImage = systemImage
    self.title = title
    self.message = message
  }
}

/// What the welcome says and when it appears. The sign-in screen that follows is not a page here: the
/// welcome is two explanatory screens, then the ordinary sign-in.
public enum Onboarding {
  /// `UserDefaults` key (also used with `@AppStorage`) that records the welcome was finished.
  public static let completedKey = "b4m.onboarding.completed"

  public static let pages: [OnboardingPage] = [
    OnboardingPage(
      id: "welcome",
      systemImage: "brain.head.profile",
      title: "Your AI workspace, in your pocket",
      message:
        "Chat with the models you use on the web, start long-running agents, and keep your images, video and music in one place."
    ),
    OnboardingPage(
      id: "notifications",
      systemImage: "bell.badge",
      title: "Know the moment it's ready",
      message:
        "Agents and long answers can take a while. Bike4Mind can notify you, and show progress on your Lock Screen, so you can put the phone down. iOS asks once, the first time you open a conversation, and you can change it any time."
    ),
  ]

  /// The welcome shows to someone who has never finished it and is signed out for no particular reason.
  /// A user who signed out, was signed out by the server or deleted their account goes straight to sign-in.
  public static func shouldShow(isCompleted: Bool, signOutReason: AuthController.SignOutReason?) -> Bool {
    !isCompleted && signOutReason == nil
  }
}
