SHELL := /bin/bash

# SAM invokes build-<LogicalId> for each function because template.yaml uses the
# makefile build method. The allow-list below deliberately copies Python source
# only; ignored OAuth/service-account JSON files can never enter a Lambda artifact.
PYTHON ?= python3
PIP_PLATFORM ?= manylinux2014_x86_64
PIP_PYTHON_VERSION ?= 3.12

DEPS_GetAlbumFunction := PyJWT==2.13.0 cryptography==49.0.0
DEPS_GetAlbumsFunction := PyJWT==2.13.0 cryptography==49.0.0
DEPS_CreateZipFunction := PyJWT==2.13.0 cryptography==49.0.0
DEPS_GetDownloadUrlFunction := PyJWT==2.13.0 cryptography==49.0.0
DEPS_ContactFunction := resend==2.34.0
DEPS_CreateAlbumFunction := ExifRead==3.5.1 resend==2.34.0
DEPS_AddImagesFunction := ExifRead==3.5.1 resend==2.34.0
DEPS_GoogleDriveBackupFunction := google-api-python-client==2.198.0 google-auth==2.56.0 google-auth-httplib2==0.4.0

.PHONY: build-%
build-%:
	@set -euo pipefail; \
	  test -n "$(ARTIFACTS_DIR)"; \
	  mkdir -p "$(ARTIFACTS_DIR)"; \
	  cp functions/*.py "$(ARTIFACTS_DIR)/"; \
	  deps='$(DEPS_$*)'; \
	  if [[ -n "$$deps" ]]; then \
	    "$(PYTHON)" -m pip install \
	      --disable-pip-version-check \
	      --no-compile \
	      --only-binary=:all: \
	      --platform "$(PIP_PLATFORM)" \
	      --implementation cp \
	      --python-version "$(PIP_PYTHON_VERSION)" \
	      --target "$(ARTIFACTS_DIR)" \
	      $$deps; \
	  fi; \
	  if find "$(ARTIFACTS_DIR)" -maxdepth 1 -type f \( \
	      -name 'google_oauth_token.json' -o \
	      -name 'voice-assistant-*.json' -o \
	      -name '*service-account*.json' -o \
	      -name '*credentials*.json' \
	    \) -print -quit | grep -q .; then \
	    echo 'Refusing to build: credential-like JSON entered a Lambda artifact.' >&2; \
	    exit 1; \
	  fi
