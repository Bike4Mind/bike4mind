import CryptoKit
import Foundation

/// RFC 7636 proof key. The server only accepts S256 with a 43-character challenge.
public struct PKCEPair: Sendable, Equatable {
  public let verifier: String
  public let challenge: String
  public let method = "S256"

  public init(verifier: String) {
    self.verifier = verifier
    self.challenge = Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
  }

  /// 32 random bytes encode to a 43-character verifier, the RFC minimum and well inside the server's 43-128 range.
  public static func generate() -> PKCEPair {
    PKCEPair(verifier: randomURLSafeString(byteCount: 32))
  }
}

enum Base64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ string: String) -> Data? {
    var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
  }
}

/// `SystemRandomNumberGenerator` is a CSPRNG on Apple platforms.
func randomURLSafeString(byteCount: Int) -> String {
  var generator = SystemRandomNumberGenerator()
  let bytes = (0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
  return Base64URL.encode(Data(bytes))
}
