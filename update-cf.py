#!/usr/bin/env python3
"""Compatibility entry point for the guarded CloudFront baseline updater."""

from pathlib import Path
import runpy

runpy.run_path(
    str(Path(__file__).resolve().parent / "ops" / "cloudfront_frontend.py"),
    run_name="__main__",
)
