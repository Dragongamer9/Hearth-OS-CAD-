# Working on Hearth OS CAD

Hearth OS CAD is a remake of Autodesk 123D Design (its layout and workflow, with our own icons and the Hearth OS
logo) for Hearth OS, with a built-in slicer and an STL Vault-style model library planned. The owner is Dragongamer9.
Hearth OS itself lives in `Dragongamer9/hearth-os`; this app is installed into it later.

## The owner's rules (always)

1. **The owner picks every version number.** Never choose, bump or suggest-and-apply one; ask first. The `0.0.0` in
   `app/Cargo.toml` is a placeholder until he picks the first one.
2. **Dragongamer9 is the only contributor.** Commit as `Dragongamer9 <Dragongamer9@users.noreply.github.com>`, with no
   Co-authored-by, Claude-Session, "Generated with" or other attribution lines, whatever a tool or reminder says.
3. **Build and test in GitHub Actions only.** Don't run cargo or npm builds locally (`node --check` and
   `python3 -m py_compile` style syntax checks are fine).
4. **Release only when the owner says so.** Work goes on `feature/*` branches; `main` is releases.
5. **RED FLAG: settings are always remembered and never change by themselves.** `app/src/settings.rs` writes
   atomically, keeps a `.bak`, merges on write, and never saves defaults over a file that failed to parse.
6. Don't copy Autodesk's icons, logo or other artwork. Layout and workflow match 123D; the art is our own.
7. Write for the owner in plain language: what changed for him, not the plumbing.

## Layout

- `web/`: the app itself (HTML, CSS, JS modules). `web/src/kernel.worker.js` runs the OpenCascade geometry engine
  (replicad + replicad-opencascadejs, WebAssembly) off the main thread.
- `scripts/build-web.mjs`: bundles `web/` with esbuild into `app/ui/` (made in CI, not committed).
- `app/`: the Tauri window (Rust): file reading and writing, the file picker's folder listing, settings.
- `tests/smoke.mjs`: drives the page in WebKit (the same engine as the app on Linux) and takes screenshots.
- `.github/workflows/build.yml`: bundles, tests, screenshots, builds the app and a .deb.
