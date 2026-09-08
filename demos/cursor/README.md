# Cursor study — local only

An isolated prototype for Ian Truong Photography. The live app does not import
this directory, and the production build does not include it.

## Plan and scope

- `index.html`: gallery, cursor controls, interaction samples, and photo dialog.
- `style.css`: existing Linen Editorial palette, responsive layout, cursor states.
- `main.js`: pointer behavior, preview preferences, drag, zoom, and dialog controls.
- `vite.config.mjs`: isolated local server and build; no production API or env.
- `assets/`: copies of the two existing bundled hero photographs.

This demo does not change the production app when run. The approved 20px version
is implemented separately in `src/components/CameraCursor.jsx`, its stylesheet,
and `src/utils/cameraCursor.js`, with semantic markers on the real site controls.
The production cursor has no demo settings UI or dependency on these assets.

## Run from the repository root

```sh
node node_modules/vite/bin/vite.js --config demos/cursor/vite.config.mjs
```

Open http://127.0.0.1:4177. To check the standalone build:

```sh
node node_modules/vite/bin/vite.js build --config demos/cursor/vite.config.mjs
node node_modules/eslint/bin/eslint.js demos/cursor/main.js
```

Build output is disposable and lives in `node_modules/.cache/cursor-study`,
separate from the live site's `dist` directory.

## Interaction direction

Start with a 20px outlined camera and action labels off; its lens is the exact
pointer position. On photo hover, the camera stays the same size and three flash
rays briefly expand from its flash, then remain still until you leave. Entering
another photograph triggers a fresh pulse. Links use an arrow;
the viewer uses zoom, close, and previous/next icons. The strip uses horizontal
arrows, contracting while held. Text and form controls keep their native cursors.
Click feedback is a small contraction. The flash stays local to the camera icon.
Version 3 adopts the chosen camera, size, and label defaults from version 2 while
retaining any background and click-feedback preference. The viewfinder option
has been removed; System remains available for comparison.

The cursor follows directly, without a trailing spring. It uses a contrasting
outer stroke for light and dark images. Preferences persist only in this demo's
local storage. Touch, forced colors, keyboard navigation, and reduced motion
have fallbacks. The floating pointer moves into the dialog's top layer while it
is open. Escape closes the viewer. The strip is scrollable by keyboard and touch.

The standalone build and lint checks validate packaging and source consistency.
Pointer feel and visual preference need the owner's hands-on review in the local
preview; no automated browser inspection has been performed.
