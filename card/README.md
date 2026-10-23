# wedgie NFC card

A business-card wedgie with an NTAG215 sticker (Ø25 mm) inside. Three prints, all face down, 0.2 mm layers.
1.6 mm thick when glued.

| Print | Files | Colors |
|---|---|---|
| Back | `back-black.stl` | black |
| Tile (the screen) | `tile-<5,10,20,eth>-black.stl` + `-color.stl` | black + one color |
| Front | `front-white/grey/green/red.stl` | white, grey, green, red |

Multi-color part: drag all its STLs into Bambu Studio at once, say yes to "load as one object", set a filament
per part.

Build: sticker into the back's pocket, tile on top (its pocket covers the sticker), front over it (its recess
holds the tile's lip). A few drops of glue between back and front.

Change sizes or add a tile: `card/make.py`, then
`uv run --with manifold3d --with numpy --with fonttools python card/make.py`.
