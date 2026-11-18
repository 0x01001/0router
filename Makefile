.DEFAULT_GOAL := help

ifeq ($(OS),Windows_NT)
  POWERSHELL := powershell -NoProfile -ExecutionPolicy Bypass -File
  DEPLOY_SCRIPT := $(POWERSHELL) scripts/deploy-windows.ps1
  RELEASE_SCRIPT := $(POWERSHELL) scripts/release-windows.ps1
else
  SHELL := /bin/bash
  DEPLOY_SCRIPT := scripts/deploy-local.sh
  RELEASE_SCRIPT := scripts/release-local.sh
endif

# Unix-style $(HOME) defaults only apply on macOS/Linux. On Windows $(HOME) is
# usually empty under make, so these would become root-relative paths like
# "/.9router" that Node resolves against the CURRENT DRIVE (e.g. D:\.9router)
# and leak into every child process via `export`. The PowerShell scripts
# resolve their own Windows defaults (%APPDATA%\9router, npm root -g, node).
ifneq ($(OS),Windows_NT)
INSTALL_DIR ?= $(HOME)/.local/lib/node_modules/9router
DATA_DIR ?= $(HOME)/.9router
NODE_BIN ?= $(HOME)/.hermes/node/bin/node
endif
PORT ?= 20128
RUN_TESTS ?= 1
AUTO_INSTALL_DEPS ?= 1
REQUIRE_CURSOR_CONTENT ?= 0
PRESERVE_PREVIOUS_STATIC ?= 1
STOP_TIMEOUT ?= 20
HEALTH_TIMEOUT ?= 45

export PORT RUN_TESTS AUTO_INSTALL_DEPS REQUIRE_CURSOR_CONTENT PRESERVE_PREVIOUS_STATIC STOP_TIMEOUT HEALTH_TIMEOUT
# Only export path vars that actually have a value (never an empty/derived-empty path).
ifneq ($(strip $(INSTALL_DIR)),)
export INSTALL_DIR
endif
ifneq ($(strip $(DATA_DIR)),)
export DATA_DIR
endif
ifneq ($(strip $(NODE_BIN)),)
export NODE_BIN
endif

.PHONY: help install build deploy deploy-only deploy-only-dry-run release release-strict release-no-test release-dry-run release-check deploy-dry-run

ifeq ($(OS),Windows_NT)
help:
	@$(POWERSHELL) scripts/make-help.ps1
else
help:
	@printf '%s\n' \
	  'Local 9Router targets:' \
	  '  make install          Install npm deps (repo root + cli).' \
	  '  make build            Build CLI bundle to cli/app (no deploy).' \
	  '  make deploy           Test, build, bump patch #, backup, replace, restart (= make release).' \
	  '  make deploy-only      Copy existing cli/app as-is (no build, no patch bump).' \
	  '  make release          Same as make deploy.' \
	  '  make release-strict   Same, but rollback unless cu/default returns real content.' \
	  '  make release-no-test  Skip unit tests; build and deploy (not recommended).' \
	  '  make release-dry-run  Print the release plan without changing anything.' \
	  '  make release-check    Validate script syntax and run the dry-run preflight.' \
	  '  make deploy-dry-run   Print the deploy (release) plan without changing anything.' \
	  '' \
	  'Step by step (macOS / Linux):' \
	  '  0. Prereqs: node, npm, make, curl, lsof' \
	  '  1. make install                                          (first time only)' \
	  '  2. make deploy INSTALL_DIR=$$(npm root -g)/9router NODE_BIN=$$(which node)' \
	  '     -> test + build + patch bump + deploy in one step' \
	  '  OR split build and deploy:' \
	  '     make build' \
	  '     make deploy-only INSTALL_DIR=$$(npm root -g)/9router NODE_BIN=$$(which node)' \
	  '  3. make deploy-only fails if cli/app is missing - run make build first' \
	  '  4. Data preserved at ~/.9router (DB, credentials - not touched)' \
	  '' \
	  'Optional overrides:' \
	  '  INSTALL_DIR=$$(npm root -g)/9router  (auto-detected by deploy script if omitted)' \
	  '  DATA_DIR=~/.9router PORT=20128 NODE_BIN=$$(which node)' \
	  '  AUTO_INSTALL_DEPS=0 (fail instead of installing missing build dependencies)' \
	  '  PRESERVE_PREVIOUS_STATIC=1 (keep one old asset generation for open tabs)'
endif

install:
	npm install
	npm --prefix cli install

build:
	npm --prefix cli run build

# `make deploy` = full release: test + build (bakes the next patch #) + deploy.
# A copy-only deploy shipped stale cli/app bundles; that is now `deploy-only`.
deploy: release

deploy-dry-run: release-dry-run

deploy-only:
	@$(DEPLOY_SCRIPT)

deploy-only-dry-run:
ifeq ($(OS),Windows_NT)
	@$(POWERSHELL) scripts/deploy-windows.ps1 -DryRun
else
	@$(DEPLOY_SCRIPT) --dry-run
endif

release:
	@$(RELEASE_SCRIPT)

release-strict: REQUIRE_CURSOR_CONTENT=1
release-strict:
ifeq ($(OS),Windows_NT)
	@$(POWERSHELL) scripts/release-windows.ps1 -Strict
else
	@$(RELEASE_SCRIPT)
endif

release-no-test: RUN_TESTS=0
release-no-test:
ifeq ($(OS),Windows_NT)
	@$(POWERSHELL) scripts/release-windows.ps1 -SkipTests
else
	@$(RELEASE_SCRIPT)
endif

release-dry-run:
ifeq ($(OS),Windows_NT)
	@$(POWERSHELL) scripts/release-windows.ps1 -DryRun
else
	@$(RELEASE_SCRIPT) --dry-run
endif

release-check:
ifeq ($(OS),Windows_NT)
	@powershell -NoProfile -Command "$$e=$$null; $$null=[System.Management.Automation.Language.Parser]::ParseFile('scripts/release-windows.ps1',[ref]$$null,[ref]$$e); $$null=[System.Management.Automation.Language.Parser]::ParseFile('scripts/deploy-windows.ps1',[ref]$$null,[ref]$$e); if($$e){$$e|ForEach-Object{$$_.Message}; exit 1}"
	@$(POWERSHELL) scripts/release-windows.ps1 -DryRun
else
	@bash -n $(RELEASE_SCRIPT)
	@bash -n scripts/deploy-local.sh
	@$(RELEASE_SCRIPT) --dry-run
endif
