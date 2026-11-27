// swift-tools-version: 6.0
import PackageDescription

// Pins the code generator used by `make generate-client`. Kept apart from B4MClient so building the
// app never fetches or compiles the generator: only its generated sources are checked in.
let package = Package(
  name: "B4MGenerator",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.14.3")
  ]
)
