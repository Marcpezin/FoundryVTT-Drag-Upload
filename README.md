![](https://img.shields.io/badge/Foundry-v13-informational)
![](https://img.shields.io/github/v/release/Marcpezin/FoundryVTT-Drag-Upload?include_prereleases)

# Drag Upload (Get Over Here!)
Drag and drop files from your computer (or your web browser) directly onto the Foundry canvas to instantly create **Tokens**, **Tiles**, **Journal Pins**, or **Ambient Sounds** — without going through the File Picker upload flow.

![](./dragupload.gif)

## How it works

Drop a file on the canvas. What gets created depends on the file type and the currently active control layer.

### Audio files
Creates an **Ambient Sound** at the cursor position, with easing and looping enabled — regardless of the active layer. Any audio extension Foundry recognises is accepted (mp3, wav, flac, ogg, m4a, …).

### Image / video files
- **Tokens layer** — Creates a 1×1 Actor and places its Token at the cursor. A dropdown dialog lets you choose which Actor type to use, or `actorless` to spawn the Token and discard the underlying Actor (useful for scene dressing or disposable extras).
- **Notes layer** — Creates a `JournalEntry` containing an image page, and places a Journal Pin at the cursor that links to it.
- **Tiles layer (or any other layer)** — Creates a Tile sized to match the image dimensions, centred on the cursor.

### Drag from the web
You can also drag an image straight from a browser tab onto the canvas — the URL is detected and used directly. A few quirky cases (Imgur low-res webp previews, query-string suffixes) are handled automatically.

## Modifier keys

| Key | Effect |
|-----|--------|
| `Shift` | Skip grid snapping |
| `Alt`   | Create the resulting object as hidden |

## Storage

Uploaded files are saved by default under `dragupload/uploaded/` in your Foundry data folder, organised in `tokens/`, `tiles/`, `ambient/`, and `journals/` subfolders. The base path is configurable in the module settings, and **S3** and **Forge VTT** storage backends are supported.

## Requirements

- Foundry VTT **v13** or later
- File upload permission (GMs have it by default)

## About this fork

The original [Drag Upload module by Cody Swendrowski](https://github.com/cswendrowski/FoundryVTT-Drag-Upload) was forked by [Amir Arad](https://github.com/amir-arad/FoundryVTT-Drag-Upload), but neither version has received updates for some time and the module had stopped working on recent Foundry releases.

This fork is a rewrite that targets **Foundry VTT v13 and later only**. Older versions (V9–V12) are no longer supported.

Notable changes vs. the upstream forks:

- Migrated to V13's namespaced APIs (`foundry.applications.*`, `DialogV2`, namespaced `FilePicker` / `DragDrop` / `loadTexture`)
- Updated to the new Tile / Token / Note / AmbientSound document schemas
- Fixed Journal Pin creation, which had been broken since V10 (now correctly creates a `JournalEntryPage` of type `image`)
- Replaced the multi-button actor-type dialog with a dropdown to handle systems with many actor types (e.g. D&D 5e) without overflow

## Installation

In Foundry's package browser, search for **Drag Upload Revived** — or install manually with this manifest URL:

```
https://github.com/Marcpezin/FoundryVTT-Drag-Upload/releases/latest/download/module.json
```

## License

MIT — see [LICENSE](LICENSE). Original work © Cody Swendrowski; subsequent contributions by Amir Arad and Marcpezin (with Claude Code)
