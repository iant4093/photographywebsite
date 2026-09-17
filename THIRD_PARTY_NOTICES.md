# Third-party notices

The website distributes the full license and copyright notices in [`public/licenses/THIRD_PARTY_NOTICES.txt`](public/licenses/THIRD_PARTY_NOTICES.txt), linked from `/licenses`. The production build generates this file from the packages included in the browser bundles, including fonts and native runtime components. `dist/licenses/packages.json` records their names and versions.

## LibRaw and rawconvert-wasm

The editor uses the MIT-licensed JavaScript worker/client from `rawconvert-wasm@0.1.1`. Its npm prebuilt native core is **not shipped**. The site instead builds a compatible core from unmodified **LibRaw 0.22.2** under **CDDL-1.0**, using the site's MIT-licensed `scripts/raw-decoder-bindings.cpp` adapter and Emscripten 4.0.18. The former JavaScript CSP patch is no longer run: the core is compiled with `DYNAMIC_EXECUTION=0`.

- [LibRaw upstream](https://www.libraw.org/) and [matching redistributed source](public/licenses/libraw-source.tar.gz).
- [Build script](scripts/build-raw-decoder.py), [adapter source](scripts/raw-decoder-bindings.cpp), and [compiler flags and artifact checksums](public/licenses/raw-decoder-build.json).
- [Native notices](legal/raw-runtime) include LibRaw, Emscripten and its C/C++ runtime, libjpeg, and zlib. This software is based in part on the work of the Independent JPEG Group.

## Maintenance

Ordinary `npm run build` uses the checked-in core, validates its source/artifact hashes, and produces the distribution notices. Missing package license text fails the build. Where an npm archive omitted its notice, `legal/upstream/licenses.json` records a version-specific upstream source and checksum; review these on dependency updates.

To rebuild native artifacts, install Emscripten 4.0.18 and run `npm run build:raw-decoder`, then `npm run test:raw-decoder`. The smoke test decodes an original synthetic DNG and checks output, invalid-file handling, reset, and CSP compatibility. Changing the compiler, ports, LibRaw, or wrapper requires review of the associated notices and decoder compatibility.

Software licenses apply to their identified components. They do not license the site's photographs; photo-use permissions are described at `/terms`.
