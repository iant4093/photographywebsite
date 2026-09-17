"""Build the shipped RAW core from the exact, redistributed LibRaw source.

Maintenance command: python3 scripts/build-raw-decoder.py
Requires Emscripten 4.0.18; ordinary website builds use checked-in artifacts.
"""
# Copyright (c) 2026 Ian Truong. MIT License; see legal/raw-bindings-LICENSE.txt.
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SHA256 = "de86b035655accff8d4010f1a221fdf50d353cb7b1422ba26f14a0db92612cfa"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    archive = ROOT / "public/licenses/libraw-source.tar.gz"
    if digest(archive) != SOURCE_SHA256:
        raise SystemExit("LibRaw source checksum mismatch")
    compiler = shutil.which("em++")
    if not compiler:
        raise SystemExit("Install Emscripten 4.0.18 to rebuild the RAW decoder")
    version = subprocess.check_output([compiler, "--version"], text=True).splitlines()[0]
    if "4.0.18" not in version:
        raise SystemExit(f"Review build flags and runtime licenses before changing compiler: {version}")
    bindings = ROOT / "scripts/raw-decoder-bindings.cpp"
    flags = ["-O2", "--no-entry", "-std=c++17", "-fexceptions", "-DLIBRAW_NOTHREADS", "-DLIBRAW_NODLL",
             "-DUSE_JPEG", "-DUSE_ZLIB", "-sUSE_LIBJPEG=1", "-sUSE_ZLIB=1", "-lembind",
             "-sMODULARIZE=1", "-sEXPORT_NAME=createRawConvertCore", "-sENVIRONMENT=web,worker,node",
             "-sDYNAMIC_EXECUTION=0", "-sALLOW_MEMORY_GROWTH=1", "-sMAXIMUM_MEMORY=2147483648",
             "-sEXPORTED_RUNTIME_METHODS=FS", "-sFORCE_FILESYSTEM=1"]
    with tempfile.TemporaryDirectory(prefix="photography-raw-build-") as temporary:
        work = Path(temporary)
        with tarfile.open(archive) as source:
            source.extractall(work, filter="data")
        libraw = work / "LibRaw-0.22.2"
        output = work / "rawconvert-core.js"
        makefile = (libraw / "Makefile.am").read_text().replace("\\\n", " ")
        source_line = re.search(r"(?m)^lib_libraw_a_SOURCES\s*=([^\n]+)", makefile)
        if not source_line:
            raise SystemExit("Cannot locate the upstream library source list")
        sources = [libraw / name for name in source_line.group(1).split()]
        result = subprocess.run([compiler, *flags, f"-I{libraw}", str(bindings), *map(str, sources), "-o", str(output)])
        if result.returncode:
            raise SystemExit(result.returncode)
        destination = ROOT / "src/editor/vendor"
        destination.mkdir(parents=True, exist_ok=True)
        for filename in ("rawconvert-core.js", "rawconvert-core.wasm"):
            shutil.copyfile(work / filename, destination / filename)
        notices = ROOT / "legal/raw-runtime"
        notices.mkdir(parents=True, exist_ok=True)
        for filename in ("LICENSE.CDDL", "LICENSE.LGPL", "COPYRIGHT"):
            shutil.copyfile(libraw / filename, notices / f"LibRaw-{filename}.txt")
        shutil.copyfile(bindings, ROOT / "public/licenses/raw-decoder-bindings.cpp")
        build_script = ROOT / "scripts/build-raw-decoder.py"
        shutil.copyfile(build_script, ROOT / "public/licenses/build-raw-decoder.py")
        manifest = {
            "librawVersion": "0.22.2", "librawLicense": "CDDL-1.0",
            "sourceUrl": "https://www.libraw.org/data/LibRaw-0.22.2.tar.gz",
            "compiler": version, "compilerFlags": flags,
            "files": {str(path.relative_to(ROOT)): digest(path) for path in [archive, bindings, build_script,
                ROOT / "public/licenses/raw-decoder-bindings.cpp", ROOT / "public/licenses/build-raw-decoder.py",
                destination / "rawconvert-core.js", destination / "rawconvert-core.wasm"]},
        }
        (ROOT / "public/licenses/raw-decoder-build.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Built LibRaw 0.22.2 core and recorded source/artifact checksums.")


if __name__ == "__main__":
    main()
