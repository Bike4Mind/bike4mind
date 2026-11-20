// swift-tools-version: 6.0
import PackageDescription

// Sources/B4MClient/Generated is produced by `make generate-client` (see apps/ios/README.md) and
// committed; nothing here runs a build plugin or touches the network at build time.
let package = Package(
  name: "B4MClient",
  platforms: [
    .iOS("17.4"),
    .macOS(.v14),
  ],
  products: [
    .library(name: "B4MClient", targets: ["B4MClient"])
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.13.3")
  ],
  targets: [
    .target(
      name: "B4MClient",
      dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")]
    ),
    .testTarget(name: "B4MClientTests", dependencies: ["B4MClient"]),
  ]
)
