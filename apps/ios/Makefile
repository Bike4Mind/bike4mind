# Bike4Mind iOS. The default targets build for the simulator; override SIMULATOR to pick another device,
# or DESTINATION for a full xcodebuild destination (CI passes one by simulator id).
# `make device` builds, installs and launches on a connected iPhone and needs a team id (see DEVICE_TESTING.md).
SIMULATOR ?= iPhone 17
DESTINATION ?= platform=iOS Simulator,name=$(SIMULATOR),OS=latest
PROJECT := Bike4Mind.xcodeproj
SCHEME := Bike4Mind
DERIVED_DATA := $(CURDIR)/build/DerivedData
# Generated sources are excluded from formatting so a regeneration diff is exactly the generator's output.
SWIFT_SOURCES = $(shell find Bike4Mind Widgets CaptureUI ActivityIntents ShareExtension Tools/GenerateAppIcon.swift Packages -name '*.swift' -not -path '*/Generated/*' -not -path '*/.build/*')

.PHONY: build device test format lint clean generate-client generate-tokens check-entitlements check-raw-colors

CLIENT_PKG := Packages/B4MClient
GENERATOR_PKG := Tools/Generator
SPEC_PATH_IN_REPO := apps/client/public/openapi.json


build:
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DESTINATION)' -derivedDataPath $(DERIVED_DATA) build

# Builds for, installs on and launches on a connected iPhone. DEVICE=<name|udid> picks one when several are plugged in.
# The team comes from Config/Local.xcconfig (DEVELOPMENT_TEAM) or `make device DEVELOPMENT_TEAM=<id>`.
# Installing over an existing copy keeps its data, so the app stays signed in.
device:
	@if [ -z "$(DEVELOPMENT_TEAM)" ] && { ! grep -Eq '^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*[A-Z0-9]{10}[[:space:]]*$$' Config/Local.xcconfig 2>/dev/null || grep -q YOURTEAMID Config/Local.xcconfig 2>/dev/null; }; then \
		echo "error: no signing team configured. Copy Config/Local.xcconfig.example to Config/Local.xcconfig and set DEVELOPMENT_TEAM (see DEVICE_TESTING.md)." >&2; exit 1; fi
	@set -e; udid=$$(Tools/select-device.sh "$$DEVICE"); \
	echo "Building for device $$udid"; \
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug -destination "id=$$udid" -derivedDataPath $(DERIVED_DATA) -allowProvisioningUpdates $(if $(DEVELOPMENT_TEAM),DEVELOPMENT_TEAM=$(DEVELOPMENT_TEAM)) build; \
	app="$(DERIVED_DATA)/Build/Products/Debug-iphoneos/$(SCHEME).app"; \
	bundle_id=$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$$app/Info.plist"); \
	xcrun devicectl device install app --device "$$udid" "$$app"; \
	xcrun devicectl device process launch --device "$$udid" --terminate-existing "$$bundle_id"

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

lint: check-entitlements check-raw-colors
	xcrun swift-format lint --strict --parallel $(SWIFT_SOURCES)

check-entitlements:
	Tools/check-entitlements-parity.sh

check-raw-colors:
	Tools/check-raw-colors.sh

clean:
	rm -rf build

# Regenerates Packages/B4MClient from an OpenAPI snapshot. Without arguments it re-runs the generator
# on the committed snapshot (reproducibility check: `git diff` must stay empty). To take a new snapshot:
#   make generate-client SPEC_REF=origin/main        # read the spec from a git ref
#   make generate-client SPEC_FILE=/path/to/openapi.json
generate-client:
	@if [ -n "$(SPEC_REF)" ]; then git show "$(SPEC_REF):$(SPEC_PATH_IN_REPO)" > $(CLIENT_PKG)/openapi.json; \
	elif [ -n "$(SPEC_FILE)" ]; then cp "$(SPEC_FILE)" $(CLIENT_PKG)/openapi.json; fi
	python3 -I $(CLIENT_PKG)/Scripts/strip_overlay_literals.py $(CLIENT_PKG)/openapi.json ../../scripts/check-no-overlay-literals.sh
	swift build --package-path $(GENERATOR_PKG) --product swift-openapi-generator
	rm -rf $(CLIENT_PKG)/Sources/B4MClient/Generated
	mkdir -p build
	python3 -I $(CLIENT_PKG)/Scripts/open_enums.py $(CLIENT_PKG)/openapi.json build/openapi-open-enums.json
	$(GENERATOR_PKG)/.build/debug/swift-openapi-generator generate build/openapi-open-enums.json \
		--config $(CLIENT_PKG)/openapi-generator-config.yaml \
		--output-directory $(CLIENT_PKG)/Sources/B4MClient/Generated

# Regenerates the design-token Swift (Packages/B4MKit/.../Theme/Generated) and the AccentColor sets from
# packages/design-tokens. The design-tokens tests fail when the committed files drift from the tokens.
generate-tokens:
	cd ../.. && pnpm --filter @bike4mind/design-tokens generate:native
