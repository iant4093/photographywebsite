# Immersive gallery wheelchairs

- Add four procedural wheelchairs just beyond reception, with visible wheels, footrests, armrests and seated first-person details.
- Add `src/utils/museumWheelchairs.js` for spawn state, interaction targeting, safe dismount and shared collision footprints.
- Add `src/components/museum/MuseumWheelchairs.jsx` for lightweight chair geometry and animated wheels.
- Integrate riding into `src/pages/ImmersiveGalleryDesktop.jsx`: F/touch interaction, fast movement, lowered seated camera, no walking bob/jump/footsteps while riding, retained chair state through pause and album viewing.
- Substep `moveMuseumPosition` in `src/utils/museumLayout.js` so high-speed movement cannot skip furniture or closed portals.
- Verify spawn clearance, high-speed collision, safe exit, overlay retention, lint, test suite, build and browser first-person rendering.
- No backend changes.

## Validation

- Full suite: 166 files / 1,649 tests passed with the fixture CDN configured (`VITE_CLOUDFRONT_DOMAIN=media.example.invalid`); the additional rotated-chair regression passed afterward.
- Final movement, wheelchair, layout and overlay checks: 78 tests passed.
- Lint, production build and dependency audit passed (zero vulnerabilities).
- Chromium browser run: board with F, camera at 1.12 m, visible armrests and seated legs, fast travel, desk collision stop, pause/resume at seated height, and safe dismount back to standing height. No browser exceptions.
- Browser evidence is in the ignored `website_review/` directory.
