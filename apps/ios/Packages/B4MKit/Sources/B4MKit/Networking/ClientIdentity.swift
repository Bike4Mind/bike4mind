import Foundation
import Observation

/// Who this build is, declared on every request so the server can tell an outdated build to upgrade
/// (`X-Client-Name` / `X-Client-Version`, b4m-core/common/src/api-contract/clientVersion.ts). The server
/// gates only a request that carries both headers, so a build whose version cannot be expressed as
/// SemVer sends neither rather than a value the server would reject as malformed.
public struct ClientIdentity: Equatable, Sendable {
  public static let nameHeader = "X-Client-Name"
  public static let versionHeader = "X-Client-Version"
  /// Must match the key an admin sets in `minimumClientVersions`. Lowercase, per the server's name rule.
  public static let iOSClientName = "b4m-ios"

  /// The running app's (or extension's) identity. Every target shares one `MARKETING_VERSION`.
  public static let current = ClientIdentity(
    name: iOSClientName,
    marketingVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)

  public let name: String
  /// `MAJOR.MINOR.PATCH`, or nil when the bundle version could not be read as one.
  public let version: String?

  public init(name: String, marketingVersion: String?) {
    self.name = name
    version = marketingVersion.flatMap(Self.semanticVersion)
  }

  /// Stamps both headers unless the request already declares a client (a caller that knows better wins).
  public func apply(to request: inout URLRequest) {
    guard let version, request.value(forHTTPHeaderField: Self.nameHeader) == nil else { return }
    request.setValue(name, forHTTPHeaderField: Self.nameHeader)
    request.setValue(version, forHTTPHeaderField: Self.versionHeader)
  }

  /// `CFBundleShortVersionString` allows one to three integers ("1", "1.2", "1.2.3"); the server wants
  /// exactly three, so missing components are zero. Anything else is not a version the server can compare.
  static func semanticVersion(_ marketingVersion: String) -> String? {
    let parts = marketingVersion.trimmingCharacters(in: .whitespaces).split(
      separator: ".", omittingEmptySubsequences: false)
    guard (1...3).contains(parts.count) else { return nil }
    var numbers: [Int] = []
    for part in parts {
      // Leading zeros are not valid SemVer identifiers; the digits-only check keeps "+1" and "-1" out.
      guard !part.isEmpty, part.allSatisfy(\.isASCIIDigit), part == "0" || !part.hasPrefix("0"),
        let number = Int(part)
      else { return nil }
      numbers.append(number)
    }
    while numbers.count < 3 { numbers.append(0) }
    return numbers.map(String.init).joined(separator: ".")
  }
}

/// The server's "this build is too old" answer: HTTP 426 with
/// `{"errorCode": "upgrade_required", "client_name": "...", "minimum_version": "..."}`.
public struct ClientUpgradeNotice: Equatable, Sendable {
  public let minimumVersion: String?

  public init(minimumVersion: String?) {
    self.minimumVersion = minimumVersion
  }
}

public enum ClientUpgradeDetector {
  public static let status = 426
  static let errorCode = "upgrade_required"

  private struct Body: Decodable {
    let errorCode: String?
    let minimumVersion: String?

    enum CodingKeys: String, CodingKey {
      case errorCode
      case minimumVersion = "minimum_version"
    }
  }

  /// Any 426 means this build is refused; the body only adds which version would be accepted.
  public static func notice(status: Int, body: Data) -> ClientUpgradeNotice? {
    guard status == Self.status else { return nil }
    let decoded = body.isEmpty ? nil : try? JSONDecoder().decode(Body.self, from: body)
    let minimumVersion = decoded?.errorCode == errorCode ? decoded?.minimumVersion : nil
    return ClientUpgradeNotice(minimumVersion: minimumVersion)
  }
}

/// Broadcasts upgrade-required answers seen anywhere on the wire. `URLSessionTransport` reports into
/// `shared`, like `AccountDeletionSignal`, so every client is covered without per-call plumbing.
public final class ClientUpgradeSignal: @unchecked Sendable {
  public static let shared = ClientUpgradeSignal()

  private let lock = NSLock()
  private var observers: [@Sendable (ClientUpgradeNotice) -> Void] = []

  public init() {}

  public func observe(_ handler: @escaping @Sendable (ClientUpgradeNotice) -> Void) {
    lock.withLock { observers.append(handler) }
  }

  public func report(_ notice: ClientUpgradeNotice) {
    let snapshot = lock.withLock { observers }
    for observer in snapshot { observer(notice) }
  }
}

/// Whether the server has refused this build. `RootView` covers the app with the update screen while set; the
/// session and the keychain are left alone, so a lowered minimum (or the installed update) puts the user
/// straight back where they were.
@MainActor
@Observable
public final class ClientUpgradeStatus {
  public private(set) var notice: ClientUpgradeNotice?
  public private(set) var isChecking = false
  @ObservationIgnored private let probe: @MainActor () async throws -> Void

  /// - Parameter probe: one request through the server's gate (`ClientVersionProbe`); throws
  ///   `APIError.upgradeRequired` while the refusal still applies.
  public init(signal: ClientUpgradeSignal = .shared, probe: @escaping @MainActor () async throws -> Void) {
    self.probe = probe
    signal.observe { [weak self] notice in
      Task { @MainActor in self?.receive(notice) }
    }
  }

  public var isUpgradeRequired: Bool { notice != nil }

  public func receive(_ notice: ClientUpgradeNotice) {
    // Keep the first answer that named a version; later ones are the same refusal.
    if self.notice?.minimumVersion == nil { self.notice = notice }
  }

  /// Asks the server again ("Try again", and every foreground). Only an answer without a 426 clears the
  /// refusal: being offline proves nothing either way.
  public func recheck() async {
    guard isUpgradeRequired, !isChecking else { return }
    isChecking = true
    defer { isChecking = false }
    do {
      try await probe()
      notice = nil
    } catch APIError.upgradeRequired, APIError.offline, is CancellationError {
      return
    } catch {
      // Any other failure is still an answer from a server that let this build through the gate.
      notice = nil
    }
  }
}

/// The re-check behind `ClientUpgradeStatus`: `GET /api/v1/whats-new?limit=1`, the cheapest contract route
/// that runs the client-version gate without a session, so it answers the same signed in or out.
public struct ClientVersionProbe: Sendable {
  private let baseURL: URL
  private let transport: any HTTPTransport

  public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) {
    self.baseURL = baseURL
    self.transport = transport
  }

  public func check() async throws {
    let url = baseURL.appending(path: "api/v1/whats-new").appending(queryItems: [
      URLQueryItem(name: "limit", value: "1")
    ])
    var request = URLRequest(url: url)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let status: Int
    do {
      status = try await transport.send(request).1.statusCode
    } catch is URLError {
      throw APIError.offline
    }
    if status == ClientUpgradeDetector.status { throw APIError.upgradeRequired }
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}
