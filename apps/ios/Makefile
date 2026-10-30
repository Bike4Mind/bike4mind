# Bike4Mind iOS. Simulator-only until signing exists; override SIMULATOR to pick another device.
SIMULATOR ?= iPhone 17
DESTINATION ?= platform=iOS Simulator,name=$(SIMULATOR),OS=latest
PROJECT := Bike4Mind.xcodeproj
SCHEME := Bike4Mind
DERIVED_DATA := $(CURDIR)/build/DerivedData
SWIFT_SOURCES := Bike4Mind Packages

.PHONY: build test format lint clean

build:
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DESTINATION)' -derivedDataPath $(DERIVED_DATA) build

# The unit suites live in the local packages and run on the simulator through each package's own
# SwiftPM scheme: a project scheme cannot list a local package's test target as a testable.
# The macOS host pass is what exercises the real Keychain: a hostless simulator test bundle has no
# keychain entitlement, so the Keychain round-trip skips there.
test:
	cd Packages/B4MKit && xcodebuild -scheme B4MKit -destination '$(DESTINATION)' -derivedDataPath $(DERIVED_DATA) test
	cd Packages/B4MKit && swift test

format:
	xcrun swift-format format --in-place --recursive --parallel $(SWIFT_SOURCES)

lint:
	xcrun swift-format lint --strict --recursive --parallel $(SWIFT_SOURCES)

clean:
	rm -rf build
