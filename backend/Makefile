SHELL := /bin/bash

# SAM invokes build-<LogicalId> for each function because template.yaml uses the
# makefile build method. The allow-list below deliberately copies Python source
# only; ignored OAuth/service-account JSON files can never enter a Lambda artifact.
PYTHON ?= python3
PIP_PLATFORM ?= manylinux2014_x86_64
PIP_PYTHON_VERSION ?= 3.12
NPM ?= npm

# Keep each Lambda artifact limited to its handler and transitive local imports.
# This list is intentionally explicit: an unmapped function fails the build
# instead of falling back to copying the entire functions directory.
SOURCES_GetPublicAlbumsFunction := cursor_helpers.py front_door.py gallery_order.py get_public_albums.py media_access.py response_helpers.py validation_helpers.py
SOURCES_GetPublicAlbumFunction := cursor_helpers.py explore_index.py front_door.py get_public_album.py media_access.py response_helpers.py validation_helpers.py
SOURCES_GetAlbumsFunction := album_access.py audit_helpers.py auth_helpers.py cursor_helpers.py front_door.py gallery_order.py get_albums.py media_access.py response_helpers.py validation_helpers.py
SOURCES_GetAlbumFunction := album_access.py audit_helpers.py auth_helpers.py cursor_helpers.py front_door.py get_album.py media_access.py response_helpers.py validation_helpers.py
SOURCES_GetSharedAlbumFunction := album_access.py audit_helpers.py auth_helpers.py cursor_helpers.py front_door.py get_shared_album.py media_access.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py
SOURCES_LoginFunction := audit_helpers.py front_door.py login.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py
SOURCES_CompleteChallengeFunction := audit_helpers.py complete_challenge.py front_door.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py
SOURCES_ContactFunction := audit_helpers.py contact.py email_helpers.py front_door.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py
SOURCES_GoogleDriveBackupFunction := google_drive_sync.py media_access.py validation_helpers.py
SOURCES_CreateAlbumFunction := album_mutation_helpers.py album_qr.py audit_helpers.py auth_helpers.py cache_invalidation.py create_album.py dynamodb_helpers.py email_helpers.py front_door.py media_access.py media_helpers.py preview_jobs.py response_helpers.py secret_helpers.py validation_helpers.py
SOURCES_UpdateAlbumFunction := album_mutation_helpers.py album_qr.py audit_helpers.py auth_helpers.py cache_invalidation.py explore_index.py front_door.py media_access.py response_helpers.py update_album.py validation_helpers.py
SOURCES_UpdateGalleryOrderFunction := audit_helpers.py auth_helpers.py cache_invalidation.py front_door.py gallery_order.py response_helpers.py update_gallery_order.py validation_helpers.py
SOURCES_DeleteAlbumFunction := audit_helpers.py auth_helpers.py cache_invalidation.py delete_album.py deletion_helpers.py explore_index.py front_door.py media_access.py response_helpers.py validation_helpers.py
SOURCES_AddImagesFunction := add_images.py album_mutation_helpers.py album_qr.py audit_helpers.py auth_helpers.py cache_invalidation.py create_album.py dynamodb_helpers.py email_helpers.py front_door.py media_access.py media_helpers.py preview_jobs.py response_helpers.py secret_helpers.py validation_helpers.py
SOURCES_CreateZipFunction := album_access.py audit_helpers.py auth_helpers.py create_zip.py cursor_helpers.py front_door.py media_access.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py zip_helpers.py
SOURCES_WorkerZipFunction := album_access.py audit_helpers.py auth_helpers.py cursor_helpers.py media_access.py validation_helpers.py worker_zip.py zip_helpers.py
SOURCES_DeleteImagesFunction := audit_helpers.py auth_helpers.py cache_invalidation.py delete_images.py deletion_helpers.py explore_index.py front_door.py media_access.py response_helpers.py validation_helpers.py
SOURCES_TagMediaObjectFunction := media_access.py tag_media_object.py validation_helpers.py
SOURCES_GetDownloadUrlFunction := album_access.py audit_helpers.py auth_helpers.py cursor_helpers.py front_door.py get_download_url.py media_access.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py zip_helpers.py
SOURCES_PreparePrintFunction := album_access.py audit_helpers.py auth_helpers.py cursor_helpers.py front_door.py media_access.py prepare_print.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py zip_helpers.py
SOURCES_UpdateImageFunction := audit_helpers.py auth_helpers.py cache_invalidation.py deletion_helpers.py front_door.py media_access.py response_helpers.py update_image.py validation_helpers.py
SOURCES_GetUploadUrlFunction := audit_helpers.py auth_helpers.py front_door.py get_upload_url.py media_access.py response_helpers.py validation_helpers.py
SOURCES_HeroCoverFunction := audit_helpers.py auth_helpers.py front_door.py hero_cover.py response_helpers.py validation_helpers.py
SOURCES_CreateUserFunction := audit_helpers.py auth_helpers.py create_user.py front_door.py response_helpers.py validation_helpers.py
SOURCES_ListUsersFunction := audit_helpers.py auth_helpers.py front_door.py list_users.py response_helpers.py validation_helpers.py
SOURCES_GetCostReportFunction := audit_helpers.py auth_helpers.py front_door.py get_cost_report.py response_helpers.py
SOURCES_AnalyticsIngestFunction := analytics.py front_door.py response_helpers.py secret_helpers.py security_helpers.py validation_helpers.py
SOURCES_GetAnalyticsReportFunction := audit_helpers.py auth_helpers.py front_door.py get_analytics_report.py response_helpers.py
SOURCES_GetGoogleDriveUsageFunction := audit_helpers.py auth_helpers.py front_door.py get_google_drive_usage.py response_helpers.py
SOURCES_GetPhotographyStatsFunction := front_door.py photography_stats.py response_helpers.py
SOURCES_RefreshGoogleDriveUsageFunction := audit_helpers.py auth_helpers.py front_door.py get_google_drive_usage.py photography_stats.py refresh_google_drive_usage.py response_helpers.py
SOURCES_DeleteUserFunction := audit_helpers.py auth_helpers.py delete_user.py deletion_helpers.py front_door.py media_access.py owner_helpers.py response_helpers.py validation_helpers.py
SOURCES_EditUserFunction := audit_helpers.py auth_helpers.py edit_user.py front_door.py owner_helpers.py response_helpers.py validation_helpers.py

DEPS_GetAlbumFunction := PyJWT==2.13.0 cryptography==50.0.0
DEPS_GetAlbumsFunction := PyJWT==2.13.0 cryptography==50.0.0
DEPS_CreateZipFunction := PyJWT==2.13.0 cryptography==50.0.0
DEPS_GetDownloadUrlFunction := PyJWT==2.13.0 cryptography==50.0.0
DEPS_PreparePrintFunction := PyJWT==2.13.0 cryptography==50.0.0
DEPS_ContactFunction := resend==2.34.0
DEPS_CreateAlbumFunction := ExifRead==3.5.1 resend==2.34.0 segno==1.6.6
DEPS_UpdateAlbumFunction := segno==1.6.6
DEPS_AddImagesFunction := ExifRead==3.5.1 resend==2.34.0 segno==1.6.6
DEPS_GoogleDriveBackupFunction := google-api-python-client==2.198.0 google-auth==2.56.0 google-auth-httplib2==0.4.0
DEPS_GetGoogleDriveUsageFunction := google-auth==2.56.0 requests==2.34.2
DEPS_RefreshGoogleDriveUsageFunction := google-auth==2.56.0 requests==2.34.2

.PHONY: build-PreviewWorkerFunction
build-PreviewWorkerFunction:
	@set -euo pipefail; \
	  test -n "$(ARTIFACTS_DIR)"; \
	  mkdir -p "$(ARTIFACTS_DIR)"; \
	  cp preview_worker/*.mjs preview_worker/package.json preview_worker/package-lock.json "$(ARTIFACTS_DIR)/"; \
	  cd "$(ARTIFACTS_DIR)"; \
	  "$(NPM)" ci \
	    --omit=dev \
	    --include=optional \
	    --no-bin-links \
	    --os=linux \
	    --cpu=x64 \
	    --libc=glibc \
	    --no-audit \
	    --no-fund; \
	  test -f node_modules/sharp/dist/index.mjs; \
	  test -d node_modules/@img/sharp-linux-x64; \
	  test -d node_modules/@img/sharp-libvips-linux-x64

.PHONY: build-%
build-%:
	@set -euo pipefail; \
	  test -n "$(ARTIFACTS_DIR)"; \
	  mkdir -p "$(ARTIFACTS_DIR)"; \
	  sources='$(SOURCES_$*)'; \
	  if [[ -z "$$sources" ]]; then \
	    echo 'Refusing to build $*: no explicit Python source allowlist exists.' >&2; \
	    exit 1; \
	  fi; \
	  for source in $$sources; do \
	    test -f "functions/$$source"; \
	    cp "functions/$$source" "$(ARTIFACTS_DIR)/"; \
	  done; \
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
