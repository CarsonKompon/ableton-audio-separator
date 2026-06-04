import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const IS_WINDOWS = process.platform === "win32";

// These are set at runtime via `initPaths()` from extension.ts,
// using the SDK-provided directories that the extension host permits writes to.
let VENV_DIR = "";
let SCRIPTS_DIR = "";
let AUDIO_SEP_BIN = "";
let PIP_BIN = "";
let PYTHON_BIN = "";
let TEMP_DIR = "";

/**
 * Must be called once at activation with the SDK-provided directories.
 * - storageDir: `context.environment.storageDirectory` — persistent (for .venv)
 * - tempDir: `context.environment.tempDirectory` — temp files (for stem output)
 */
export function initPaths(storageDir: string, tempDir: string) {
  VENV_DIR = path.join(storageDir, ".venv");
  SCRIPTS_DIR = path.join(VENV_DIR, IS_WINDOWS ? "Scripts" : "bin");
  AUDIO_SEP_BIN = path.join(SCRIPTS_DIR, IS_WINDOWS ? "audio-separator.exe" : "audio-separator");
  PIP_BIN = path.join(SCRIPTS_DIR, IS_WINDOWS ? "pip.exe" : "pip");
  PYTHON_BIN = path.join(SCRIPTS_DIR, IS_WINDOWS ? "python.exe" : "python");
  TEMP_DIR = tempDir;
}

/** Returns the resolved paths for debugging. */
export function getVenvPaths() {
  return { VENV_DIR, SCRIPTS_DIR, AUDIO_SEP_BIN, PIP_BIN, PYTHON_BIN, TEMP_DIR };
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
 * Checks whether the local venv has audio-separator installed.
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

      proc.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        if (code === 0) {
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

/**
 * Logs audio-separator environment info (GPU detection, CUDA availability).
 * Call this after confirming audio-separator is installed.
 */
export async function logEnvironmentInfo(): Promise<string> {
  try {
    if (!fs.existsSync(AUDIO_SEP_BIN)) return "audio-separator not installed";
  } catch {
    return "Cannot check audio-separator (fs access denied)";
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
 * Creates a Python venv in the extension directory and installs audio-separator into it.
 * Reports progress via the `onProgress` callback and supports cancellation.
 */
export async function installAudioSeparator(
  useGpu: boolean,
  onProgress: (message: string, percentage: number | undefined) => void,
  signal: AbortSignal,
): Promise<boolean> {
  // Step 1: Create the venv if it doesn't exist.
  if (!fs.existsSync(VENV_DIR)) {
    onProgress("Creating Python virtual environment...", undefined);
    // Ensure storage directory exists.
    await fs.promises.mkdir(path.dirname(VENV_DIR), { recursive: true });
    await runCommand(`python -m venv "${VENV_DIR}"`, signal);
  }

  signal.throwIfAborted();

  // Step 2: Upgrade pip inside the venv.
  onProgress("Upgrading pip...", undefined);
  await runCommand(`"${PYTHON_BIN}" -m pip install --upgrade pip`, signal);

  signal.throwIfAborted();

  // Step 3: Install CUDA-enabled PyTorch if GPU mode selected.
  // pip's default PyTorch is CPU-only; we need the CUDA index for GPU support.
  if (useGpu) {
    onProgress("Installing PyTorch with CUDA support...", undefined);
    await runCommand(
      `"${PIP_BIN}" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121`,
      signal,
    );
    signal.throwIfAborted();
  }

  // Step 4: Install audio-separator into the venv.
  const extra = useGpu ? "gpu" : "cpu";
  onProgress(`Installing audio-separator[${extra}]...`, undefined);

  return new Promise<boolean>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Installation was cancelled."));
      return;
    }

    const command = `"${PIP_BIN}" install "audio-separator[${extra}]"`;
    const proc = spawn(command, [], { shell: true });

    const abortHandler = () => {
      proc.kill("SIGTERM");
      reject(new Error("Installation was cancelled."));
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    let output = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;

      const dlMatch = text.match(/Downloading\s+\S+\s+\(([^)]+)\)/);
      if (dlMatch) {
        onProgress(`Downloading ${dlMatch[1]}...`, undefined);
      }

      const pctMatch = text.match(/(\d{1,3})%/);
      if (pctMatch) {
        onProgress("Downloading packages...", parseInt(pctMatch[1], 10));
      }

      if (text.includes("Installing collected packages")) {
        onProgress("Installing packages...", undefined);
      }

      if (text.includes("Successfully installed")) {
        onProgress("Installation complete!", 100);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", abortHandler);
      reject(new Error(`Failed to run pip: ${err.message}`));
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", abortHandler);
      if (signal.aborted) return;

      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(
          `pip install failed (exit code ${code}).\n${output.slice(-500)}`
        ));
      }
    });
  });
}

/**
 * Runs audio-separator on the given input file with the specified config.
 * Uses the venv-local binary directly — no PATH dependency.
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
  ];

  if (config.useGpu) {
    args.push("--use_autocast");
  }

  return new Promise<SeparationResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Separation was cancelled."));
      return;
    }

    onProgress("Starting separation...", undefined);

    const fullCommand = `"${AUDIO_SEP_BIN}" ${args.join(" ")}`;
    const proc: ChildProcess = spawn(fullCommand, [], { shell: true });

    let stderrBuffer = "";

    const abortHandler = () => {
      proc.kill("SIGTERM");
      reject(new Error("Separation was cancelled."));
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      const progress = parseProgress(text);
      if (progress !== null) {
        onProgress("Separating stems...", progress);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;

      // Parse progress percentage from tqdm output.
      const progress = parseProgress(text);
      if (progress !== null) {
        onProgress("Separating stems...", progress);
      }

      // Extract meaningful status messages (stem names, phases).
      const status = parseStatusMessage(text);
      if (status) {
        onProgress(status, undefined);
      }

      // Detect model download progress.
      if (text.includes("Downloading")) {
        const dlProgress = parseProgress(text);
        onProgress("Downloading model...", dlProgress ?? undefined);
      }
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
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, [], { shell: true });
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
