# Miro synchronization status

The existing board has been rebuilt with all 12 architecture views, a linked
navigation frame, and the complete source inventory. The old overlapping
diagrams have been removed. The board's 187 architecture nodes and 134 directed
connections were checked against `model.py`; all 412 rows in the 16 embedded
inventory tables were read back successfully. Exact item links are in
`miro-map.json`.

The Miro connector reached its Free-plan limit of 100 calls per day during the
final typography pass. Browser editing subsequently became unavailable. The
remaining work is visual formatting; the architecture content is saved:

- Views 00–05 have enlarged separate connection labels. Views 06–11 retain the
  original native connector captions. Generate their intended label objects
  with `python3 ops/architecture/build.py --miro-dir /tmp/photography-atlas`.
- The subtitles in views 01–03 need their text-box width restored from 3350 to
  2680 after Miro expanded it during a font-size change.
- View 00's subtitle was repaired through the browser to fit inside the frame;
  its font is 24 rather than the generator's intended 30. If increasing it,
  explicitly restore the intended width and position afterward.

To finish, read each current frame through `layout_read` before editing. Reuse
its existing item URLs, preserve all node/edge relationships, clear the small
native captions only when the corresponding enlarged labels are created, and
verify text bounds. Do not create duplicate architecture frames or replace the
inventory document. The local Mermaid atlas is complete and all twelve diagrams
render successfully.
