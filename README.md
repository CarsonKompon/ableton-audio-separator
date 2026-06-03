# Ableton UVR Extension

Stem separation inside Ableton Live — powered by [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) and the same AI models used in [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui).

Right-click any audio clip or arrangement selection and split it into stems (vocals, instrumental, drums, bass, guitar, piano) without leaving Live.

## Features

- **2-stem separation** — Vocals + Instrumental (BS-Roformer, MelBand Roformer, MDX-NET)
- **4-stem separation** — Vocals, Drums, Bass, Other (HTDemucs FT)
- **6-stem separation** — Vocals, Drums, Bass, Guitar, Piano, Other (HTDemucs 6s)
- **GPU accelerated** — CUDA support for fast inference
- **Auto-install** — creates a local Python venv and installs everything on first use
- **Progress feedback** — live progress dialog with model download and separation status
- **Single undo** — all created tracks can be undone in one step

## Requirements

- **Ableton Live 12 Beta** with Extensions SDK support
- **Python 3.10+** on your system PATH
- **NVIDIA GPU + CUDA** (optional, for fast processing — falls back to CPU)

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

On first use, it will create a `.venv/` in the extension directory and install `audio-separator` with CUDA PyTorch. This is a one-time ~3GB download.

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
  separator.ts    — Python venv management, audio-separator CLI wrapper
  tracks.ts       — Import stems and create audio tracks in the Live Set
ui/
  settings.html   — Modal dialog UI for separation settings
```

## How It Works

1. The extension renders audio from Live via `renderPreFxAudio()` (or uses the clip's file directly)
2. Spawns `audio-separator` from the local `.venv/` with the chosen model
3. Monitors stdout/stderr for progress updates (model download, tqdm bars)
4. Imports the resulting stem WAV files back into the project
5. Creates new audio tracks per stem, named like "TrackName — Vocals"
6. All track creation is grouped for single-undo

## Troubleshooting

- **Slow separation?** Check the console for `CUDAExecutionProvider available`. If missing, delete `.venv/` and reinstall with GPU option.
- **Install fails?** Ensure `python` is on your PATH and points to Python 3.10+.
- **Duplicate menu entries?** Restart Live before running `npm start`.

## License

MIT
