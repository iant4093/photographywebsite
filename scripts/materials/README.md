# Gallery material preparation

The 3D gallery's newer materials use real, matching CC0 wood scans plus a few
procedural response maps I generate myself. None of this touches the existing
photography or the authored wallpaper, and nothing gets generated per frame at
runtime.

You need Python and Pillow. Pillow is pinned in
`backend/functions/requirements.txt`, which the repo's Python CI environment
installs.

```sh
python scripts/materials/prepare_gallery_materials.py
python scripts/materials/prepare_gallery_materials.py --check
```

The first command downloads any source JPEGs it doesn't have yet into a
`museum-material-sources` folder in the OS temp directory. Pass
`--source-dir PATH` to reuse a source cache you already have. Every source is
pinned by SHA-256 and only fetched from the official Poly Haven CDN. With
Pillow 12.3.0 the output is deterministic. The second command
works offline and doesn't write anything.

## Sources and how to use them

| Material | Resolution | Source / role | Physical tile | Roughness mean |
| --- | --- | --- | --- | --- |
| Oak flooring | 1024² × 3 | [Wood Floor](https://polyhaven.com/a/wood_floor), matching albedo / GL normal / roughness | 1.7 m, about 19 cm planks | 0.471 absolute |
| Walnut joinery | 512² × 3 | [American Walnut Veneer](https://polyhaven.com/a/american_walnut_veneer), matching albedo / GL normal / roughness | 1 m, continuous horizontal grain | 0.556 absolute |
| Fine plaster | 512² × 2 | Periodic mineral micro-normal / roughness, even material-color tint | 0.5 m | 0.878 multiplier |
| Satin brass | 256² × 1 | Periodic brushing roughness, material metalness/color | 0.16 m | 0.871 multiplier |
| Glazed ceramic | 256² × 1 | Subtle periodic glaze roughness, material color | 0.25 m | 0.898 multiplier |
| Woven textile | 256² × 2 | Soft periodic warp/weft normal / roughness | 0.12 m | 0.937 multiplier |

Poly Haven assets are [CC0](https://polyhaven.com/license). Full provenance is
in `public/assets/museum/textures/SOURCES.txt`.

Only albedo textures are sRGB. Normal and roughness textures have to be read as
linear data. Three.js reads roughness from the green channel, and the
monochrome files I ship are copied equally into R, G and B, so that channel is
right.

Keep normal strengths modest, since the maps already carry shallow surface
detail:

- floor: around 0.22–0.30
- joinery: 0.16–0.24
- fine plaster: 0.18–0.25
- woven textile: 0.20–0.30

Metallic roughness maps don't change metalness.

The scans hold surface color, not gallery lighting. Keep the material tints
light so that color comes through: the floor's mean sRGB is about 128/96/66 and
the walnut's is about 115/110/106. A dark brown multiplier would darken them a
second time. Roughness maps multiply the material's roughness value. The scans
expect a value of about 1.0, while the generated near-white response maps only
nudge the base roughness you pick. Use mipmaps and capped anisotropy for detail
in the distance.

## Size and checks

All twelve delivered images for the new materials add up to 886,652 bytes
(0.85 MiB). They replace the old ~100 KiB floor set and can replace the old
~150 KiB plaster set. A conservative full RGBA8-plus-mipmaps estimate is
24 MiB of texture memory. Replacing the old 512² floor/plaster set, that's about
16 MiB more, assuming texture uploads are shared across repeated materials.
These assets don't need any extra geometry, draw calls, runtime lights or
shadow passes. The old maps they replace are no longer packaged in the
frontend build, but because deploys only upload, their existing CDN objects
stay put for older cached clients.

The fine-plaster normal keeps its full 512² analytic detail as a 67,352-byte,
quality-92 JPEG with 4:4:4 sampling. That's 151,681 bytes smaller than the PNG
it replaced. Its decoded per-channel RMS error is 2.37/1.66/1.07 out of 255
against the lossless normal field, which at the recommended 0.2 normal strength
works out to about 0.26 degrees RMS angular error. Compression doesn't change
the field, the physical scale or the normal strength. The other generated maps
are still lossless PNG.

`--check` verifies:

- image sizes, and that data maps have no embedded ICC transforms;
- normal-channel averages and unit lengths;
- seam samples on the lossless generated maps, which must be identical;
- JPEG seam and channel error against the original analytic field, within a
  set limit;
- a 1 MiB ceiling on the total download for these materials;
- a 26 MiB ceiling on the conservative texture-memory estimate.

All source channels go through the same resize, and the normal JPEG is saved
without chroma subsampling.
