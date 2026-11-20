import Foundation

/// Public pages on the marketing site; the web app links to the same ones at sign-up.
enum AppLinks {
  static let terms = URL(string: "https://bike4mind.com/terms-of-service")!
  static let privacy = URL(string: "https://bike4mind.com/privacy")!
  /// PLACEHOLDER: the App Store front page until the app has an App Store id. Replace with
  /// `https://apps.apple.com/app/id<APP_STORE_ID>` once the listing exists.
  static let appStore = URL(string: "https://apps.apple.com")!
}

enum AppInfo {
  /// "1.0 (42)" from the bundle, or just the version when the build number is missing.
  static var versionDescription: String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "0"
    guard let build = info?["CFBundleVersion"] as? String else { return version }
    return "\(version) (\(build))"
  }
}
