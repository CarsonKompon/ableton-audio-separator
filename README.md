# Ableton Audio Separatttor

Stem separation inside Ableton Live — powered by [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) and the same AI models used in [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui).

Right-click any audio clip or arrangement selection and split it into stems (vocals, instrumental, drums, bass, guitar, piano) without leaving Live.

## Features

- **2-stem separation** — Vocals + Instrumental (BS-Roformer, MelBand Roformer, MDX-NET)
- **4-stem separation** — Vocals, Drums, Bass, Other (HTDemucs FT)
- **6-stem separation** — Vocals, Drums, Bass, Guitar, Piano, Other (HTDemucs 6s)
- **GPU accelerated** — CUDA support for fast inference
- **Auto-install** — uses [uv](https://docs.astral.sh/uv/) to create a local Python venv and install dependencies automatically (no system Python required)
- **Progress feedback** — single unified progress dialog from render through separation to track creation
- **Single undo** — all created tracks can be undone in one step

## Requirements

- **Ableton Live 12 Beta** with Extensions SDK support
- **NVIDIA GPU + CUDA** (optional, for fast processing — falls back to CPU)

> **Note:** Python is managed automatically by `uv`. You do not need Python on your PATH.

## Setup

1. Clone/download this repository
2. Install Node.js dependencies:
   ```sh
   npm install
   ```
3. Set the Extension Host path in `.env` (pre-filled by the generator):
   ```
   EXTENSION_HOST_PATH=C:\ProgramData\Ableton\Live 12 Beta\Program\ExtensionHost\ExtensionHostNodeModule.node
   ```
4. Enable **Developer Mode** in Ableton Live: Settings → Extensions

## Usage

```sh
npm start       # build + launch in Live's Extension Host
```

Once running in Live:

1. **Right-click an audio clip** → "Separate Clip Stems (UVR)"
2. **Or select a time range** on an audio track → right-click → "Separate Selection Stems (UVR)"
3. Choose separation mode, model, and options in the dialog
4. Click **Separate** — the extension handles the rest

On first use, `uv` will be downloaded and a local Python environment with `audio-separator` will be created in the extension's storage directory. Model files are downloaded on first use of each model (~100MB–1GB depending on model).

## Scripts

```sh
npm start          # build + run in Live's Extension Host
npm run build      # production bundle
npm run build:dev  # dev bundle (sourcemaps, not minified)
npm run package    # build + create a .ablx archive for distribution
```

## Project Structure

```
src/
  extension.ts    — Entry point: commands, context menus, orchestration
  separator.ts    — uv-managed local venv, audio-separator CLI wrapper
  tracks.ts       — Import stems and create audio tracks in the Live Set
ui/
  settings.html   — Modal dialog UI for separation settings
```

## How It Works

1. User selects separation settings from a modal dialog
2. The extension renders audio from Live via `renderPreFxAudio()`
3. Calls `audio-separator` from the local `.venv/` with the chosen model
4. Monitors stdout/stderr for progress updates (model download, tqdm bars)
5. Imports the resulting stem files back into the project
6. Creates new audio tracks per stem, named like "TrackName — Vocals"
7. All track creation is grouped in a transaction for single-undo

## Troubleshooting

- **"audio-separator not found" on every launch?** Delete the `.venv` folder in the extension's storage directory and reinstall. On Windows this is at `%LOCALAPPDATA%\Ableton\Extensions Data\carson-kompon.audio-separator\.venv`.
- **Slow separation?** Delete the `.venv` folder and reinstall with the GPU option. Check that CUDA PyTorch was installed (look for "Installing PyTorch with CUDA support" in the progress dialog).
- **Duplicate menu entries?** Restart Live before running `npm start`.

## License

MIT
