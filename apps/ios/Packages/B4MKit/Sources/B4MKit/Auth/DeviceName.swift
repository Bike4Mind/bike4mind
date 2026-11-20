import Foundation

#if canImport(UIKit)
  import UIKit
#endif

/// Sent as `deviceName` at token exchange so Active Sessions can label this device.
public enum DeviceName {
  /// Without the user-assigned-device-name entitlement iOS reports the generic model ("iPhone", "iPad").
  @MainActor
  public static var current: String? {
    #if canImport(UIKit)
      UIDevice.current.name
    #else
      Host.current().localizedName
    #endif
  }
}
