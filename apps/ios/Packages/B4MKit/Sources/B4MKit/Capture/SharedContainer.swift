import Foundation
import Security

/// What the app and its share extension share: an App Group container (upload jobs, payload files, the
/// remembered destination) and a Keychain access group (the auth session).
///
/// Both degrade instead of failing when the entitlement is missing (unsigned simulator builds, SwiftPM test
/// hosts): the container falls back to Application Support and the keychain group to `nil`, which means the
/// extension simply cannot see the app's session and asks the user to open the app.
public enum SharedContainer {
  public static let appGroupIdentifier = "group.com.bike4mind.app"
  /// Appended to the team's `AppIdentifierPrefix` to form the keychain access group in the entitlements.
  public static let keychainGroupSuffix = "com.bike4mind.shared"

  /// The App Group container, or a private Application Support directory when the group is unavailable.
  public static func directory(fileManager: FileManager = .default) -> URL {
    if let group = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
      // macOS hands back the URL without creating it; iOS always has it.
      try? fileManager.createDirectory(at: group, withIntermediateDirectories: true)
      return group
    }
    let fallback = URL.applicationSupportDirectory.appending(path: "B4MShared", directoryHint: .isDirectory)
    try? fileManager.createDirectory(at: fallback, withIntermediateDirectories: true)
    return fallback
  }

  /// Shared preferences. `UserDefaults(suiteName:)` yields a usable (process-local) suite even without
  /// the entitlement, so callers never have to branch.
  public static func defaults() -> UserDefaults {
    UserDefaults(suiteName: appGroupIdentifier) ?? .standard
  }
}

/// Resolves the full keychain access group (`<TeamID>.com.bike4mind.shared`).
public enum KeychainAccessGroup {
  /// The access group to give `KeychainTokenStore`, or `nil` when the keychain-access-groups entitlement is
  /// not in effect, in which case the item stays private to the app (the pre-extension behavior).
  public static func resolved(suffix: String = SharedContainer.keychainGroupSuffix) -> String? {
    guard let defaultGroup = probeDefaultGroup(), let prefix = teamPrefix(fromDefaultGroup: defaultGroup) else {
      return nil
    }
    return prefix + suffix
  }

  /// `"ABCDE12345.com.bike4mind.shared"` -> `"ABCDE12345."`. An entitlement-less build reports no prefix
  /// (an empty or dotless group), which is how an unsigned simulator build is told apart.
  static func teamPrefix(fromDefaultGroup group: String) -> String? {
    guard let dot = group.firstIndex(of: "."), dot != group.startIndex else { return nil }
    let team = group[..<dot]
    // Team IDs are ten alphanumerics; anything else (a reverse-DNS group like "com.apple...") is not one.
    guard team.count == 10, team.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
    return String(group[...dot])
  }

  /// Writes and reads back a throwaway item to learn which access group the system files new items under.
  private static func probeDefaultGroup() -> String? {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.bike4mind.accessgroup-probe",
      kSecAttrAccount as String: "probe",
    ]
    SecItemDelete(base as CFDictionary)
    var add = base
    add[kSecValueData as String] = Data([0])
    add[kSecReturnAttributes as String] = true
    var result: CFTypeRef?
    guard SecItemAdd(add as CFDictionary, &result) == errSecSuccess,
      let attributes = result as? [String: Any]
    else { return nil }
    SecItemDelete(base as CFDictionary)
    return attributes[kSecAttrAccessGroup as String] as? String
  }
}
