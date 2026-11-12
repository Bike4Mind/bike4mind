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
  dependencies: [
    .package(path: "../B4MClient"),
    .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.13.3"),
    .package(url: "https://github.com/apple/swift-http-types", from: "1.3.0"),
  ],
  targets: [
    .target(
      name: "B4MKit",
      dependencies: [
        "B4MClient",
        .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
        .product(name: "HTTPTypes", package: "swift-http-types"),
      ]
    ),
    .testTarget(name: "B4MKitTests", dependencies: ["B4MKit"]),
  ]
)
