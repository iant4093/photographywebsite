# Gallery material preparation

The gallery's new material family uses real, matching CC0 wood scans and a small
set of original procedural response maps. Existing photography and authored
wallpaper remain untouched. Nothing is synthesized in the frame loop.

Run with Python and Pillow (the repository's Python CI environment includes it):

```sh
python scripts/materials/prepare_gallery_materials.py
python scripts/materials/prepare_gallery_materials.py --check
```

The first command downloads only missing source JPEGs into the operating system's
temporary `museum-material-sources` directory. `--source-dir PATH` can use an
existing source cache. Sources are pinned by SHA-256 and fetched only from the
official Poly Haven CDN. Delivery is deterministic with Pillow 12.3.0. The second
command is offline and does not write any files.

## Source and interpretation

| Material | Resolution | Source / role | Physical tile | Roughness mean |
| --- | --- | --- | --- | --- |
| Oak flooring | 1024² × 3 | [Wood Floor](https://polyhaven.com/a/wood_floor), matching albedo / GL normal / roughness | 1.7 m, about 19 cm planks | 0.471 absolute |
| Walnut joinery | 512² × 3 | [American Walnut Veneer](https://polyhaven.com/a/american_walnut_veneer), matching albedo / GL normal / roughness | 1 m, continuous horizontal grain | 0.556 absolute |
| Fine plaster | 512² × 2 | Periodic mineral micro-normal / roughness, even material-color tint | 0.5 m | 0.878 multiplier |
| Satin brass | 256² × 1 | Periodic brushing roughness, material metalness/color | 0.16 m | 0.871 multiplier |
| Glazed ceramic | 256² × 1 | Subtle periodic glaze roughness, material color | 0.25 m | 0.898 multiplier |
| Woven textile | 256² × 2 | Soft periodic warp/weft normal / roughness | 0.12 m | 0.937 multiplier |

Poly Haven assets are [CC0](https://polyhaven.com/license). Complete provenance is
in `public/assets/museum/textures/SOURCES.txt`.

Only albedo textures use sRGB. Normal and roughness textures must use linear data
interpretation. Three.js reads roughness from the green channel; the delivered
monochrome files expand equally across RGB, so that channel remains correct.
Keep normal strengths modest: floor around 0.22–0.30, joinery 0.16–0.24, fine
plaster 0.18–0.25, and woven textile 0.20–0.30. The texture maps already contain
shallow surface detail. Metallic roughness maps do not change metalness.

The scans contain surface color, not exhibition lighting. Light material tints
preserve their response: the floor's mean sRGB is approximately 128/96/66 and the
walnut's is 115/110/106. Dark brown multipliers would darken those colors again.
Roughness maps multiply the material scalar; source scans use an approximately
1.0 scalar, while the generated near-white response maps vary the chosen base
roughness only slightly. Use mipmaps and bounded anisotropy for distant detail.

## Cost and checks

All twelve new-family delivery images total 886,652 bytes (0.85 MiB). This
replaces the old ~100 KiB floor family and can replace the old ~150 KiB plaster
family. The conservative full RGBA8+mipmap footprint is 24 MiB; replacing the old
512² floor/plaster family gives about 16 MiB additional storage when texture
uploads are shared across repeated materials. No geometry, extra draw calls,
runtime lights, or shadow passes are required by these assets. Superseded legacy
maps are no longer packaged in the frontend artifact; upload-only deployment
retains their existing CDN objects for older cached clients.

The fine-plaster normal retains its full 512² analytic detail in a 67,352-byte,
quality-92 JPEG with 4:4:4 sampling, saving 151,681 bytes against the former PNG.
Its decoded channel RMS error is 2.37/1.66/1.07 out of 255 against the lossless
normal field. At the recommended 0.2 normal strength this corresponds to about
0.26 degrees RMS angular error. Compression does not change the field, physical
scale, or material normal strength. Other generated maps remain lossless PNG.

`--check` verifies exact image sizes, no embedded ICC transforms for data maps,
normal-channel averages and unit lengths, exact lossless generated seam samples,
bounded JPEG seam/channel error against the original analytic field, a 1 MiB
family transfer ceiling, and a 26 MiB conservative texture-memory ceiling. All
source channels undergo the same resize, and normal JPEG delivery disables
chroma subsampling.
