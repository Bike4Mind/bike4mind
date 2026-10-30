// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "B4MKit",
  platforms: [
    .iOS("17.4"),
    // macOS lets `swift test` run the suite on the host without a simulator.
    .macOS(.v14),
  ],
  products: [
    .library(name: "B4MKit", targets: ["B4MKit"])
  ],
  targets: [
    .target(name: "B4MKit"),
    .testTarget(name: "B4MKitTests", dependencies: ["B4MKit"]),
  ]
)
