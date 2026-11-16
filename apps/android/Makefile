# Bike4Mind Android. Needs a JDK 17+ on PATH (CI uses 21) and an Android SDK (ANDROID_HOME or local.properties);
# Gradle comes from the pinned wrapper.
GRADLE := ./gradlew
CLIENT := client
SPEC_PATH_IN_REPO := apps/client/public/openapi.json

.PHONY: build test lint clean generate-client

build:
	$(GRADLE) assemble

test:
	$(GRADLE) test

# Android lint for the app module; warnings the project has not opted out of fail the build.
lint:
	$(GRADLE) :app:lintDebug

clean:
	$(GRADLE) clean

# Regenerates client/generated from the committed OpenAPI snapshot. Without arguments it re-runs the generator
# on the snapshot (reproducibility check: `git diff` must stay empty). To take a new snapshot:
#   make generate-client SPEC_REF=origin/main        # read the spec from a git ref
#   make generate-client SPEC_FILE=/path/to/openapi.json
# Pipeline mirrors apps/ios `make generate-client`: strip overlay literals, open string enums, then generate.
generate-client:
	@if [ -n "$(SPEC_REF)" ]; then git show "$(SPEC_REF):$(SPEC_PATH_IN_REPO)" > $(CLIENT)/openapi.json; \
	elif [ -n "$(SPEC_FILE)" ]; then cp "$(SPEC_FILE)" $(CLIENT)/openapi.json; fi
	python3 -I $(CLIENT)/scripts/strip_overlay_literals.py $(CLIENT)/openapi.json ../../scripts/check-no-overlay-literals.sh
	mkdir -p $(CLIENT)/build
	python3 -I $(CLIENT)/scripts/open_enums.py $(CLIENT)/openapi.json $(CLIENT)/build/openapi-open-enums.json
	python3 -I $(CLIENT)/scripts/filter_operations.py $(CLIENT)/operations.txt $(CLIENT)/build/openapi-open-enums.json $(CLIENT)/build/openapi-filtered.json
	rm -rf $(CLIENT)/generated/src $(CLIENT)/generated/.openapi-generator
	$(GRADLE) --quiet :client:openApiGenerate
