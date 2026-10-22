# Gallery material preparation

`prepare_gallery_materials.py` produces the 3D gallery's wood, plaster, brass,
ceramic and textile texture maps. The wood maps are matching CC0 scans from
Poly Haven; the other maps are generated procedurally by the script. The
script runs offline and writes only these files to
`public/assets/museum/textures/`. It does not modify photographs or the
authored wallpaper.

Requirements: Python and Pillow. Pillow is pinned to 13.0.0 in
`backend/functions/requirements.txt`, which the CI Python environment installs
through `backend/requirements-dev.txt`. Use the pinned version to reproduce the
committed files.

```sh
python scripts/materials/prepare_gallery_materials.py
python scripts/materials/prepare_gallery_materials.py --check
```

The first command downloads any missing source JPEGs into a
`museum-material-sources` folder in the OS temp directory, then writes the
delivery files and runs the checks. Pass `--source-dir PATH` to reuse an
existing source cache. Each source is pinned by SHA-256 and downloaded only
from `dl.polyhaven.org`. The `--check` command runs only the checks; it does
not download or write anything.

## Sources and usage

| Material | Resolution | Source / role | Physical tile | Roughness mean |
| --- | --- | --- | --- | --- |
| Oak flooring | 1024² × 3 | [Wood Floor](https://polyhaven.com/a/wood_floor), matching albedo / GL normal / roughness | 1.7 m, about 19 cm planks | 0.471 absolute |
| Walnut joinery | 512² × 3 | [American Walnut Veneer](https://polyhaven.com/a/american_walnut_veneer), matching albedo / GL normal / roughness | 1 m, continuous horizontal grain | 0.556 absolute |
| Fine plaster | 512² × 2 | Periodic mineral micro-normal / roughness, even material-color tint | 0.5 m | 0.878 multiplier |
| Satin brass | 256² × 1 | Periodic brushing roughness, material metalness/color | 0.16 m | 0.871 multiplier |
| Glazed ceramic | 256² × 1 | Subtle periodic glaze roughness, material color | 0.25 m | 0.898 multiplier |
| Woven textile | 256² × 2 | Soft periodic warp/weft normal / roughness | 0.12 m | 0.937 multiplier |

Tile sizes and roughness means are also defined in
`src/utils/museumMaterialAssets.js`. Poly Haven assets are
[CC0](https://polyhaven.com/license). Full provenance is in
`public/assets/museum/textures/SOURCES.txt`.

Only albedo textures are sRGB. Normal and roughness textures are linear data.
Three.js reads roughness from the green channel. The roughness files are
grayscale, so they decode to equal R, G and B values.

Suggested normal strengths:

- floor: 0.22–0.30
- joinery: 0.16–0.24
- fine plaster: 0.18–0.25
- woven textile: 0.20–0.30

The brass map is roughness only; metalness comes from the material.

The scans hold surface color, not gallery lighting. Keep material tints light
so that color comes through: the floor albedo's mean sRGB is about 128/96/66
and the walnut's is about 115/110/106. A dark brown tint would darken them a
second time. Roughness maps multiply the material's roughness value. The scans
encode absolute roughness and expect a material value of about 1.0. The
generated near-white maps only adjust the chosen base roughness. Use mipmaps
and capped anisotropy for distant detail.

## Size and checks

The twelve delivery files total 886,652 bytes (0.85 MiB). They replace the
previous 512² Wood Floor set (about 100 KiB) and White Plaster 02 set (about
150 KiB). The script's conservative RGBA8-plus-mipmaps estimate is 24 MiB of
texture memory, about 16 MiB more than the replaced 512² floor and plaster
maps, assuming textures are shared across repeated materials. The replaced
files are no longer in the frontend build. Frontend deploys upload without
deleting, so the old CDN objects remain available to older cached clients.

The fine-plaster normal map is a 512² quality-92 JPEG with 4:4:4 sampling, at
67,352 bytes. That is 151,681 bytes smaller than the PNG it replaced. Its
decoded per-channel RMS error against the lossless analytic normal field is
2.37/1.66/1.07 out of 255, about 0.26 degrees RMS angular error at a normal
strength of 0.2. The other generated maps are lossless PNG.

`--check` verifies:

- image dimensions, and that no file embeds an ICC profile;
- normal-map channel means and unit length;
- identical seam samples on the generated PNG maps;
- the plaster normal JPEG's sampling, RMS error and seam error against the
  analytic field, and its size (under 70 KiB);
- a total download under 1 MiB;
- a texture-memory estimate under 26 MiB.

All channels of a scanned material go through the same resize, and every JPEG
is saved without chroma subsampling.
