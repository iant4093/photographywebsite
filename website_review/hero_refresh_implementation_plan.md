# Gallery hero refresh and processing

- Investigate the photo/video publication manifests, CDN responses, worker queue and actual browser image. Both current uploads were published September 9 at about 6:12 PM Pacific; fixed image URLs can remain reused by an open browser.
- Update `src/utils/mediaUrls.js` and a shared hero hook to revalidate photo/video manifests, select immutable versioned images, and refresh on page focus, publication and a bounded interval without delaying the initial hero paint.
- Update `Home.jsx`, `Videos.jsx`, and `ManageHero.jsx` to use the published versions. Keep the chosen upload preview while waiting for its exact version and report success only after publication; show a useful timeout instead of promising a minute.
- Optimize the preview worker's hero rendering to decode and orient the original once and bound concurrent encodes/uploads. Preserve originals, existing quality settings, namespaces and authorization.
- Add regression coverage for publication waiting, stale versions, photo/video isolation, refresh, orientation and accepted formats. Run the repository verification and worker tests, benchmark the rendering change, then release using the established deployment path and verify production.

Validation: all 1,071 frontend tests, 15 preview infrastructure tests, worker coverage, lint, production build, SAM worker build, dependency audit and frontend artifact budgets pass. Local rendering benchmark: 9,308 ms before, 5,085 ms after (45% faster), with the same quality settings. Manifest validation is lazy loaded and admin publication waiting stays outside the initial gallery bundle.
