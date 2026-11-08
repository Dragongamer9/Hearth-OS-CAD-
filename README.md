# Hearth OS CAD

A friendly 3D CAD app for [Hearth OS](https://hearthos.fun), laid out like the much-missed Autodesk 123D Design:
drop shapes on the grid, move and rotate them, join and cut them, and export them for printing.

**Status: stage 1, in development. Not released yet.**

## Stage 1 (now)

- 123D-style layout: tool groups along the top, light grid, view cube, navigation strip, Units and Grid in the corner
- Shapes: box, cylinder, sphere, cone, torus, wedge, with sizes you can type
- Move and rotate with handles that snap to the grid
- Join, subtract and intersect
- Undo and redo, save and open (`.hcad`)
- Open STL, 3MF, OBJ, PLY, GLB/GLTF and STEP
- Export STL, 3MF, OBJ, GLB and STEP
- Convert files between formats, one or many at a time

## Coming next

Sketching, extrude and revolve, press/pull, fillet, chamfer, shell, measuring and patterns (stage 2); the built-in
slicer with an Anycubic Chiron profile (stage 3); the Vault model library.

## Built on

[OpenCascade](https://dev.opencascade.org/) through [replicad](https://replicad.xyz) for the geometry,
[three.js](https://threejs.org) for the 3D view, and [Tauri](https://tauri.app) for the window.

Licensed GPL-3.0-or-later.
