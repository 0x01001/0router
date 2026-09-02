SHELL := /bin/bash
.DEFAULT_GOAL := help

RELEASE_SCRIPT := scripts/release-local.sh

INSTALL_DIR ?= $(HOME)/.local/lib/node_modules/9router
DATA_DIR ?= $(HOME)/.9router
PORT ?= 20128
NODE_BIN ?= $(HOME)/.hermes/node/bin/node
RUN_TESTS ?= 1
AUTO_INSTALL_DEPS ?= 1
REQUIRE_CURSOR_CONTENT ?= 0
STOP_TIMEOUT ?= 20
HEALTH_TIMEOUT ?= 45

export INSTALL_DIR DATA_DIR PORT NODE_BIN RUN_TESTS AUTO_INSTALL_DEPS REQUIRE_CURSOR_CONTENT STOP_TIMEOUT HEALTH_TIMEOUT

.PHONY: help release release-strict release-no-test release-dry-run release-check

help:
	@printf '%s\n' \
	  'Local 9Router release targets:' \
	  '  make release          Test, build, backup, replace, restart, and health-check.' \
	  '  make release-strict   Same, but rollback unless cu/default returns real content.' \
	  '  make release-no-test  Skip unit tests; build and deploy (not recommended).' \
	  '  make release-dry-run  Print the release plan without changing anything.' \
	  '  make release-check    Validate script syntax and run the dry-run preflight.' \
	  '' \
	  'Optional overrides:' \
	  '  INSTALL_DIR=~/.local/lib/node_modules/9router' \
	  '  DATA_DIR=~/.9router PORT=20128 NODE_BIN=~/.hermes/node/bin/node' \
	  '  AUTO_INSTALL_DEPS=0 (fail instead of installing missing build dependencies)' \
	  '  CURSOR_DEFAULT_UPSTREAM_MODEL=claude-4.5-sonnet'

release:
	@$(RELEASE_SCRIPT)

release-strict: REQUIRE_CURSOR_CONTENT=1
release-strict:
	@$(RELEASE_SCRIPT)

release-no-test: RUN_TESTS=0
release-no-test:
	@$(RELEASE_SCRIPT)

release-dry-run:
	@$(RELEASE_SCRIPT) --dry-run

release-check:
	@bash -n $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --dry-run
