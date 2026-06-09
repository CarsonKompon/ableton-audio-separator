import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const IS_WINDOWS = process.platform === "win32";

/** Current extension version — update on each release. */
const EXTENSION_VERSION = "1.1.1";
const VERSION_FILE = ".extension-version";

// Set at runtime via `initPaths()`.
let TEMP_DIR = "";
let STORAGE_DIR = "";
let UV_BIN = "";
let VENV_DIR = "";
let AUDIO_SEP_BIN = "";
let MODELS_DIR = "";

/**
 * Must be called once at activation with the SDK-provided directories.
 */
export function initPaths(storageDir: string, tempDir: string) {
  STORAGE_DIR = storageDir;
  TEMP_DIR = tempDir;
  VENV_DIR = path.join(storageDir, ".venv");
  MODELS_DIR = path.join(storageDir, "models");
  const scriptsDir = path.join(VENV_DIR, IS_WINDOWS ? "Scripts" : "bin");
  AUDIO_SEP_BIN = path.join(scriptsDir, IS_WINDOWS ? "audio-separator.exe" : "audio-separator");

  // Check for a local uv binary in storage, otherwise fall back to PATH
  try {
    const localUv = path.join(storageDir, "uv", IS_WINDOWS ? "uv.exe" : "uv");
    if (fs.existsSync(localUv)) {
      UV_BIN = localUv;
    } else {
      UV_BIN = "uv";
    }
  } catch {
    UV_BIN = "uv";
  }
}

/** Returns the resolved paths for debugging. */
export function getPaths() {
  return { UV_BIN, VENV_DIR, AUDIO_SEP_BIN, STORAGE_DIR, TEMP_DIR };
}

/**
 * Checks the stored version in STORAGE_DIR.
 * If no version file exists (pre-1.1.1 install), wipes the storage folder
 * so everything can be reinstalled cleanly. Writes the current version afterward.
 */
export function checkStorageVersion(): void {
  const versionFilePath = path.join(STORAGE_DIR, VERSION_FILE);
  let existingVersion: string | null = null;

  try {
    if (fs.existsSync(versionFilePath)) {
      existingVersion = fs.readFileSync(versionFilePath, "utf-8").trim();
    }
  } catch {
    existingVersion = null;
  }

  if (!existingVersion) {
    // No version file — legacy install from before 1.1.1. Wipe everything.
    console.log("[UVR] No version file found — clearing storage for clean reinstall.");
    try {
      fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    } catch (err) {
      console.error("[UVR] Failed to clear storage directory:", err);
    }
    // Re-init paths since UV_BIN may have been set from a now-deleted dir
    initPaths(STORAGE_DIR, TEMP_DIR);
  }

  // Write current version.
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(versionFilePath, EXTENSION_VERSION, "utf-8");
  } catch (err) {
    console.error("[UVR] Failed to write version file:", err);
  }
}

/**
 * Ensures a `ffmpeg` (and `ffprobe`) symlink exists in the venv's bin directory,
 * pointing to the binary bundled by imageio-ffmpeg. audio-separator calls `ffmpeg`
 * by name via subprocess, so it must be on PATH as literally "ffmpeg".
 */
function ensureFfmpegSymlinks(): void {
  const binDir = path.join(VENV_DIR, IS_WINDOWS ? "Scripts" : "bin");
  const ffmpegLink = path.join(binDir, IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg");
  const ffprobeLink = path.join(binDir, IS_WINDOWS ? "ffprobe.exe" : "ffprobe");

  // Skip if symlinks already exist.
  if (fs.existsSync(ffmpegLink) && fs.existsSync(ffprobeLink)) return;

  // Find the imageio_ffmpeg binaries directory.
  let searchDir: string | undefined;
  if (IS_WINDOWS) {
    searchDir = path.join(VENV_DIR, "Lib", "site-packages", "imageio_ffmpeg", "binaries");
  } else {
    try {
      const libDir = path.join(VENV_DIR, "lib");
      const entries = fs.readdirSync(libDir);
      const pyDir = entries.find((e) => e.startsWith("python3"));
      if (pyDir) {
        searchDir = path.join(libDir, pyDir, "site-packages", "imageio_ffmpeg", "binaries");
      }
    } catch { /* ignore */ }
  }

  if (!searchDir || !fs.existsSync(searchDir)) {
    console.warn("[UVR] imageio_ffmpeg binaries directory not found:", searchDir);
    return;
  }

  try {
    const files = fs.readdirSync(searchDir);

    // imageio-ffmpeg names binaries like "ffmpeg-linux-amd64-v7" or "ffmpeg-osx-arm64-v7"
    const ffmpegBin = files.find((f) => f.startsWith("ffmpeg") && !f.includes("probe"));
    const ffprobeBin = files.find((f) => f.startsWith("ffprobe"));

    if (ffmpegBin && !fs.existsSync(ffmpegLink)) {
      const target = path.join(searchDir, ffmpegBin);
      try {
        fs.symlinkSync(target, ffmpegLink);
        console.log(`[UVR] Created ffmpeg symlink: ${ffmpegLink} -> ${target}`);
      } catch {
        // Symlinks may fail on Windows without admin. Copy instead.
        fs.copyFileSync(target, ffmpegLink);
        console.log(`[UVR] Copied ffmpeg to: ${ffmpegLink}`);
      }
    }

    if (ffprobeBin && !fs.existsSync(ffprobeLink)) {
      const target = path.join(searchDir, ffprobeBin);
      try {
        fs.symlinkSync(target, ffprobeLink);
      } catch {
        fs.copyFileSync(target, ffprobeLink);
      }
    }
  } catch (err) {
    console.error("[UVR] Failed to create ffmpeg symlinks:", err);
  }
}

/** Available separation modes with their corresponding model filenames. */
export const SEPARATION_MODELS = {
  "2-stem": [
    { name: "BS-Roformer (Best Quality)", filename: "model_bs_roformer_ep_317_sdr_12.9755.ckpt" },
    { name: "MelBand Roformer (Vocals)", filename: "vocals_mel_band_roformer.ckpt" },
    { name: "UVR-MDX-NET Karaoke", filename: "UVR_MDXNET_KARA_2.onnx" },
    { name: "UVR-MDX-NET Inst HQ 3", filename: "UVR-MDX-NET-Inst_HQ_3.onnx" },
  ],
  "4-stem": [
    { name: "HTDemucs FT (Best Quality)", filename: "htdemucs_ft.yaml" },
    { name: "HTDemucs (Faster)", filename: "htdemucs.yaml" },
  ],
  "6-stem": [
    { name: "HTDemucs 6-stem", filename: "htdemucs_6s.yaml" },
  ],
} as const;

export type SeparationMode = keyof typeof SEPARATION_MODELS;

export interface SeparationConfig {
  mode: SeparationMode;
  modelFilename: string;
  outputFormat: "WAV" | "FLAC";
  useGpu: boolean;
}

export interface SeparationResult {
  /** Map of stem name (e.g., "Vocals", "Instrumental") to absolute file path. */
  stems: Map<string, string>;
}

/**
 * Checks whether audio-separator is installed in the local venv.
 * Returns the version string if found, or null if not available.
 */
export async function checkAudioSeparatorAvailable(): Promise<string | null> {
  try {
    if (!fs.existsSync(AUDIO_SEP_BIN)) {
      return null;
    }
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    try {
      const proc = spawn(`"${AUDIO_SEP_BIN}" --version`, [], { shell: true });
      let output = "";

      proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { output += data.toString(); });

      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** Check if `uv` binary is available. */
async function checkUvAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(`"${UV_BIN}" --version`, [], { shell: true });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Logs audio-separator environment info.
 */
export async function logEnvironmentInfo(): Promise<string> {
  try {
    if (!fs.existsSync(AUDIO_SEP_BIN)) return "audio-separator not installed";
  } catch {
    return "audio-separator not installed";
  }
  return new Promise((resolve) => {
    try {
      const proc = spawn(`"${AUDIO_SEP_BIN}" --env_info`, [], { shell: true });
      let output = "";

      proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { output += data.toString(); });

      proc.on("error", () => resolve("Failed to get env info"));
      proc.on("close", () => resolve(output.trim()));
    } catch (err) {
      resolve(`Failed to spawn: ${err}`);
    }
  });
}

/**
 * Installs `uv` (if needed) then creates a local venv and installs audio-separator into it.
 * Everything stays in storageDirectory — self-contained and cleans up on uninstall.
 */
export async function installAudioSeparator(
  useGpu: boolean,
  onProgress: (message: string, percentage: number | undefined) => void,
  signal: AbortSignal,
): Promise<boolean> {
  // Step 1: Ensure uv is available.
  const uvAvailable = await checkUvAvailable();
  if (!uvAvailable) {
    onProgress("Installing uv package manager...", undefined);
    await installUv(signal);
    signal.throwIfAborted();
  }

  // Step 2: Create venv in storageDirectory if it doesn't exist.
  // Specify --python 3.11 so uv downloads Python if none is on the system.
  if (!fs.existsSync(VENV_DIR)) {
    onProgress("Creating Python environment...", 10);
    await runCommand(`"${UV_BIN}" venv "${VENV_DIR}" --python 3.11`, signal);
    signal.throwIfAborted();
  }

  // All uv pip commands use VIRTUAL_ENV env var to ensure correct venv targeting.
  const pipEnv = { ...process.env, VIRTUAL_ENV: VENV_DIR };

  // Step 3: Install CUDA PyTorch first if GPU mode (must come from the CUDA index).
  if (useGpu) {
    onProgress("Installing PyTorch with CUDA support...", 20);
    await runCommandWithEnv(
      `"${UV_BIN}" pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121`,
      signal,
      pipEnv,
    );
    signal.throwIfAborted();
  }

  // Step 4: Install audio-separator into the venv.
  const extra = useGpu ? "gpu" : "cpu";
  onProgress(`Installing audio-separator[${extra}]...`, useGpu ? 50 : 30);

  return new Promise<boolean>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Installation was cancelled."));
      return;
    }

    const command = `"${UV_BIN}" pip install "audio-separator[${extra}]" imageio-ffmpeg`;
    const proc = spawn(command, [], { shell: true, env: pipEnv });

    const abortHandler = () => {
      proc.kill("SIGTERM");
      reject(new Error("Installation was cancelled."));
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    let output = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (text.includes("Resolved")) onProgress("Resolving dependencies...", 60);
      if (text.includes("Downloading")) onProgress("Downloading packages...", 70);
      if (text.includes("Installing")) onProgress("Installing packages...", 85);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (text.includes("Resolved")) onProgress("Resolving dependencies...", 60);
      if (text.includes("Downloading")) onProgress("Downloading packages...", 70);
      if (text.includes("Installing")) onProgress("Installing packages...", 85);
    });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", abortHandler);
      reject(new Error(`Failed to run uv pip install: ${err.message}`));
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", abortHandler);
      if (signal.aborted) return;

      if (code === 0) {
        // Verify the binary actually exists after install.
        if (!fs.existsSync(AUDIO_SEP_BIN)) {
          reject(new Error(
            `Installation completed but audio-separator binary not found at expected path: ${AUDIO_SEP_BIN}\n` +
            `Venv dir: ${VENV_DIR}\nOutput: ${output.slice(-300)}`
          ));
          return;
        }
        // Create ffmpeg/ffprobe symlinks in venv bin so audio-separator can find them.
        ensureFfmpegSymlinks();
        onProgress("Installation complete!", 100);
        resolve(true);
      } else {
        reject(new Error(
          `Installation failed (exit code ${code}).\n${output.slice(-500)}`
        ));
      }
    });
  });
}

/** Get the python binary path inside the local venv. */
function getVenvPython(): string {
  return path.join(VENV_DIR, IS_WINDOWS ? "Scripts" : "bin", IS_WINDOWS ? "python.exe" : "python");
}

/**
 * Installs `uv` into the extension's storage directory.
 * Uses the official standalone installer scripts.
 */
async function installUv(signal: AbortSignal): Promise<void> {
  const uvDir = path.join(STORAGE_DIR, "uv");
  await fs.promises.mkdir(uvDir, { recursive: true });

  let command: string;
  if (IS_WINDOWS) {
    // Use PowerShell to download and run the official installer
    command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $env:UV_INSTALL_DIR='${uvDir}'; irm https://astral.sh/uv/install.ps1 | iex }"`;
  } else {
    command = `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="${uvDir}" sh`;
  }

  await runCommand(command, signal);

  // Update UV_BIN to the newly installed binary.
  const installedBin = path.join(uvDir, IS_WINDOWS ? "uv.exe" : "uv");
  if (fs.existsSync(installedBin)) {
    UV_BIN = installedBin;
  } else {
    // The installer might put it in a bin/ subdirectory
    const binSubdir = path.join(uvDir, "bin", IS_WINDOWS ? "uv.exe" : "uv");
    if (fs.existsSync(binSubdir)) {
      UV_BIN = binSubdir;
    } else {
      // Fall back — maybe the installer put it on PATH
      UV_BIN = "uv";
    }
  }
}

/**
 * Runs audio-separator on the given input file with the specified config.
 * Calls the venv binary directly for unbuffered progress output.
 */
export async function separateAudio(
  inputFilePath: string,
  config: SeparationConfig,
  onProgress: (message: string, percentage: number | undefined) => void,
  signal: AbortSignal,
): Promise<SeparationResult> {
  // Ensure temp dir exists before creating subdirectory.
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const outputDir = await fs.promises.mkdtemp(path.join(TEMP_DIR, "uvr-stems-"));

  const args = [
    `"${inputFilePath}"`,
    "--model_filename", `"${config.modelFilename}"`,
    "--output_dir", `"${outputDir}"`,
    "--output_format", config.outputFormat,
    "--model_file_dir", `"${MODELS_DIR}"`,
  ];

  if (config.useGpu) {
    args.push("--use_autocast");
  }

  return new Promise<SeparationResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Separation was cancelled."));
      return;
    }

    const fullCommand = `"${AUDIO_SEP_BIN}" ${args.join(" ")}`;
    // Ensure ffmpeg symlinks exist (idempotent) and add venv bin to PATH
    // so audio-separator's subprocess calls to "ffmpeg" resolve correctly.
    ensureFfmpegSymlinks();
    const venvBinDir = path.join(VENV_DIR, IS_WINDOWS ? "Scripts" : "bin");
    const envPath = `${venvBinDir}${path.delimiter}${process.env.PATH || ""}`;
    const proc: ChildProcess = spawn(fullCommand, [], {
      shell: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PATH: envPath },
    });

    let stderrBuffer = "";

    // Only HTDemucs FT does multiple passes (2 iterations per stem).
    // All other models (Roformer, MDX-NET, regular HTDemucs) do a single pass.
    const isFtModel = config.modelFilename === "htdemucs_ft.yaml";
    let passCount = 0;
    let totalPasses = isFtModel
      ? (config.mode === "6-stem" ? 12 : 8)
      : 1;
    let lastProgress = 0;
    let isDownloading = false;

    const abortHandler = () => {
      proc.kill("SIGTERM");
      reject(new Error("Separation was cancelled."));
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    function handleProgress(text: string) {
      // Detect model download phase.
      if (text.includes("Downloading")) {
        isDownloading = true;
        const dlProgress = parseProgress(text);
        if (dlProgress !== null) {
          onProgress("Downloading model...", Math.round(dlProgress * 0.1)); // 0-10% for download
        } else {
          onProgress("Downloading model...", undefined);
        }
        return;
      }

      if (isDownloading && (text.includes("Loading") || text.includes("%|"))) {
        isDownloading = false;
      }

      const progress = parseProgress(text);
      if (progress !== null) {
        // Detect pass reset (progress went backwards significantly).
        if (progress < lastProgress - 20) {
          passCount++;
        }
        lastProgress = progress;

        // Calculate overall progress: reserve 10-95% for separation.
        const separationRange = 85; // 10% to 95%
        const perPassRange = separationRange / totalPasses;
        const overallProgress = 10 + (passCount * perPassRange) + (progress / 100) * perPassRange;

        const stemLabel = totalPasses > 1
          ? `Separating stems (pass ${passCount + 1}/${totalPasses})...`
          : "Separating stems...";
        onProgress(stemLabel, Math.min(Math.round(overallProgress), 95));
        return;
      }

      // Extract meaningful status messages.
      const status = parseStatusMessage(text);
      if (status && !isDownloading) {
        onProgress(status, undefined);
      }
    }

    proc.stdout?.on("data", (data: Buffer) => {
      handleProgress(data.toString());
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      handleProgress(text);
    });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", abortHandler);
      reject(new Error(`Failed to start audio-separator: ${err.message}`));
    });

    proc.on("close", async (code) => {
      signal.removeEventListener("abort", abortHandler);

      if (signal.aborted) return;

      if (code !== 0) {
        reject(new Error(
          `audio-separator exited with code ${code}.\n${stderrBuffer.slice(-500)}`
        ));
        return;
      }

      try {
        const stems = await collectOutputStems(outputDir);

        if (stems.size === 0) {
          // List all files for debugging
          const allFiles = await listAllFiles(outputDir);
          reject(new Error(
            `Separation completed but no output stems were detected.\n` +
            `Output directory: ${outputDir}\n` +
            `Files found: ${allFiles.join(", ") || "(none)"}`
          ));
          return;
        }

        console.log("[UVR] Found stems:", [...stems.entries()].map(([k, v]) => `${k}: ${path.basename(v)}`));
        onProgress("Separation complete!", 100);
        resolve({ stems });
      } catch (err) {
        reject(new Error(`Failed to read output directory: ${err}`));
      }
    });
  });
}

/** Parse a percentage value from tqdm-style progress output. */
function parseProgress(text: string): number | null {
  const match = text.match(/(\d{1,3})%\|/);
  if (match) {
    return Math.min(parseInt(match[1], 10), 100);
  }
  const fallback = text.match(/\b(\d{1,3})%/);
  if (fallback) {
    return Math.min(parseInt(fallback[1], 10), 100);
  }
  return null;
}

/** Extract a meaningful status message from stderr output. */
function parseStatusMessage(text: string): string | null {
  // Demucs shows "Separating track" or similar stem-level messages.
  if (text.includes("Separating")) {
    const stemMatch = text.match(/Separating\s+(\w+)/i);
    if (stemMatch) return `Separating ${stemMatch[1]}...`;
  }
  // Model loading phase.
  if (text.includes("Loading model")) return "Loading model...";
  if (text.includes("loading") && text.includes("model")) return "Loading model...";
  // Inference starting.
  if (text.includes("Processing")) return "Processing audio...";
  return null;
}

/** Recursively lists all files for debugging. */
async function listAllFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await listAllFiles(fullPath);
        results.push(...sub);
      } else {
        results.push(path.relative(dir, fullPath) || entry.name);
      }
    }
  } catch {
    // Permission denied or other error
  }
  return results;
}

/** Recursively collects all audio files from the output directory and infers stem names. */
async function collectOutputStems(outputDir: string): Promise<Map<string, string>> {
  const stems = new Map<string, string>();
  const audioExtensions = [".wav", ".flac", ".mp3", ".ogg"];

  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (audioExtensions.some(ext => entry.name.toLowerCase().endsWith(ext))) {
        const stemName = inferStemName(entry.name);
        // If we can't infer a stem name, use the base filename (capitalized)
        const name = stemName ?? capitalize(path.basename(entry.name, path.extname(entry.name)));
        stems.set(name, fullPath);
      }
    }
  }

  await walk(outputDir);
  return stems;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Infers the stem name from an output filename.
 * Handles multiple naming patterns:
 * - MDX/Roformer: "input_(Vocals)_model.wav" → "Vocals"
 * - HTDemucs: "(Track Name)_(Vocals)_htdemucs.wav" → "Vocals"
 * - Bare filename: "vocals.wav" → "Vocals"
 */
function inferStemName(filename: string): string | null {
  const baseName = path.basename(filename, path.extname(filename)).toLowerCase();

  const KNOWN_STEMS: Record<string, string> = {
    vocals: "Vocals",
    voice: "Vocals",
    drums: "Drums",
    bass: "Bass",
    other: "Other",
    guitar: "Guitar",
    piano: "Piano",
    instrumental: "Instrumental",
    no_vocals: "Instrumental",
    karaoke: "Instrumental",
  };

  // Strategy 1: Find a known stem name inside parentheses
  // Matches all (...) groups and checks if any is a known stem
  const allParens = filename.match(/\(([^)]+)\)/g);
  if (allParens) {
    for (const paren of allParens) {
      const inner = paren.slice(1, -1); // strip ( and )
      const key = inner.toLowerCase().replace(/\s+/g, "_");
      if (KNOWN_STEMS[key]) {
        return KNOWN_STEMS[key];
      }
    }
  }

  // Strategy 2: Check if a known stem name appears anywhere separated by _ or -
  for (const [key, label] of Object.entries(KNOWN_STEMS)) {
    // Match as a word boundary (between underscores, hyphens, or start/end)
    const re = new RegExp(`(?:^|[_\\-])${key}(?:$|[_\\-])`, "i");
    if (re.test(baseName)) {
      return label;
    }
  }

  // Strategy 3: Bare filename is exactly a known stem
  if (KNOWN_STEMS[baseName]) {
    return KNOWN_STEMS[baseName];
  }

  return null;
}

/** Cleans up temporary stem files after they've been imported into the project. */
export async function cleanupTempFiles(stems: Map<string, string>): Promise<void> {
  for (const filePath of stems.values()) {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Best-effort cleanup.
    }
  }

  if (stems.size > 0) {
    const firstPath = stems.values().next().value;
    if (firstPath) {
      const dir = path.dirname(firstPath);
      try {
        await fs.promises.rmdir(dir);
      } catch {
        // Not empty or already removed.
      }
    }
  }
}

/** Helper: run a shell command and wait for completion. */
function runCommand(command: string, signal: AbortSignal): Promise<void> {
  return runCommandWithEnv(command, signal);
}

/** Helper: run a shell command with optional custom env and wait for completion. */
function runCommandWithEnv(command: string, signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, [], { shell: true, ...(env ? { env } : {}) });
    } catch (err) {
      reject(new Error(`Failed to spawn command: ${err}`));
      return;
    }

    const abortHandler = () => {
      proc.kill("SIGTERM");
      reject(new Error("Cancelled."));
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    let output = "";
    proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", abortHandler);
      reject(err);
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", abortHandler);
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code}): ${command}\n${output.slice(-300)}`));
    });
  });
}