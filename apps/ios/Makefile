# Bike4Mind iOS. Simulator-only until a team id is configured; override SIMULATOR to pick another device.
SIMULATOR ?= iPhone 17
DESTINATION ?= platform=iOS Simulator,name=$(SIMULATOR),OS=latest
PROJECT := Bike4Mind.xcodeproj
SCHEME := Bike4Mind
DERIVED_DATA := $(CURDIR)/build/DerivedData
# Generated sources are excluded from formatting so a regeneration diff is exactly the generator's output.
SWIFT_SOURCES = $(shell find Bike4Mind Widgets CaptureUI ShareExtension Tools/GenerateAppIcon.swift Packages -name '*.swift' -not -path '*/Generated/*' -not -path '*/.build/*')

.PHONY: build test format lint clean generate-client check-entitlements

CLIENT_PKG := Packages/B4MClient
GENERATOR_PKG := Tools/Generator
SPEC_PATH_IN_REPO := apps/client/public/openapi.json


build:
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DESTINATION)' -derivedDataPath $(DERIVED_DATA) build

# The unit suites live in the local packages and run on the simulator through each package's own
# SwiftPM scheme: a project scheme cannot list a local package's test target as a testable.
# The macOS host pass is what exercises the real Keychain: a hostless simulator test bundle has no
# keychain entitlement, so the Keychain round-trip skips there.
test: check-entitlements
	cd Packages/B4MKit && xcodebuild -scheme B4MKit -destination '$(DESTINATION)' -derivedDataPath $(DERIVED_DATA) test
	cd Packages/B4MKit && swift test
	cd $(CLIENT_PKG) && swift test

format:
	xcrun swift-format format --in-place --parallel $(SWIFT_SOURCES)

lint: check-entitlements
	xcrun swift-format lint --strict --parallel $(SWIFT_SOURCES)

check-entitlements:
	Tools/check-entitlements-parity.sh

clean:
	rm -rf build

# Regenerates Packages/B4MClient from an OpenAPI snapshot. Without arguments it re-runs the generator
# on the committed snapshot (reproducibility check: `git diff` must stay empty). To take a new snapshot:
#   make generate-client SPEC_REF=origin/main        # read the spec from a git ref
#   make generate-client SPEC_FILE=/path/to/openapi.json
generate-client:
	@if [ -n "$(SPEC_REF)" ]; then git show "$(SPEC_REF):$(SPEC_PATH_IN_REPO)" > $(CLIENT_PKG)/openapi.json; \
	elif [ -n "$(SPEC_FILE)" ]; then cp "$(SPEC_FILE)" $(CLIENT_PKG)/openapi.json; fi
	swift build --package-path $(GENERATOR_PKG) --product swift-openapi-generator
	rm -rf $(CLIENT_PKG)/Sources/B4MClient/Generated
	mkdir -p build
	python3 -I $(CLIENT_PKG)/Scripts/open_enums.py $(CLIENT_PKG)/openapi.json build/openapi-open-enums.json
	$(GENERATOR_PKG)/.build/debug/swift-openapi-generator generate build/openapi-open-enums.json \
		--config $(CLIENT_PKG)/openapi-generator-config.yaml \
		--output-directory $(CLIENT_PKG)/Sources/B4MClient/Generated
