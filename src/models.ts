import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";

let MODELS_DIR = "";

const MANIFEST_FILE = "models.json";

const DOWNLOAD_CHECKS_URL =
  "https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json";

export type ModelCategory = "VR" | "MDX-Net" | "Roformer" | "Demucs" | "MDX23C" | "Other";
export type StemMode = "2-stem" | "4-stem" | "6-stem";

export interface UserModel {
  name: string;
  filename: string;
  source: "uvr" | "huggingface" | "local";
  category: ModelCategory;
  stemMode: StemMode;
  configFilename?: string;
  downloadUrl?: string;
}

export interface RemoteModel {
  name: string;
  filename: string;
  category: ModelCategory;
  stemMode: StemMode;
  /** URL(s) to download. For Roformer models, includes config yaml URL. */
  downloads: Record<string, string>;
}

/** Initialize models directory. Must be called after initPaths. */
export function initModelsDir(storageDir: string): void {
  MODELS_DIR = path.join(storageDir, "models");
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  } catch { /* already exists */ }
}

export function getModelsDir(): string {
  return MODELS_DIR;
}

/** Read the installed models manifest from disk. */
export function getInstalledModels(): UserModel[] {
  const manifestPath = path.join(MODELS_DIR, MANIFEST_FILE);
  try {
    if (fs.existsSync(manifestPath)) {
      const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.error("[UVR] Failed to read models manifest:", err);
  }
  return [];
}

/** Save the installed models manifest to disk. */
function saveModelManifest(models: UserModel[]): void {
  const manifestPath = path.join(MODELS_DIR, MANIFEST_FILE);
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(models, null, 2), "utf-8");
  } catch (err) {
    console.error("[UVR] Failed to write models manifest:", err);
  }
}

/** Fetch the UVR curated model list from GitHub. */
export async function fetchUvrModelList(): Promise<RemoteModel[]> {
  const json = await fetchJson(DOWNLOAD_CHECKS_URL);
  return parseUvrDownloadChecks(json);
}

/** Download a model file (and optionally its config) into MODELS_DIR. */
export async function downloadModel(
  model: RemoteModel | { name: string; filename: string; downloads: Record<string, string>; category: ModelCategory; stemMode: StemMode },
  onProgress: (message: string, percentage: number | undefined) => void,
  signal: AbortSignal,
): Promise<UserModel> {
  const filenames = Object.keys(model.downloads);
  const totalFiles = filenames.length;
  let completed = 0;

  for (const [filename, url] of Object.entries(model.downloads)) {
    signal.throwIfAborted();
    const dest = path.join(MODELS_DIR, filename);
    if (fs.existsSync(dest)) {
      completed++;
      continue;
    }
    const label = totalFiles > 1
      ? `Downloading ${filename} (${completed + 1}/${totalFiles})...`
      : `Downloading ${model.name}...`;
    onProgress(label, Math.round((completed / totalFiles) * 80));
    await downloadFile(url, dest, signal);
    completed++;
  }

  // Determine config filename (the yaml file if present).
  const configFilename = filenames.find((f) => f.endsWith(".yaml"));
  const mainFilename = filenames.find((f) => !f.endsWith(".yaml")) || model.filename;

  const userModel: UserModel = {
    name: model.name,
    filename: mainFilename,
    source: "uvr",
    category: model.category,
    stemMode: model.stemMode,
    configFilename,
    downloadUrl: Object.values(model.downloads)[0],
  };

  // Add to manifest.
  const installed = getInstalledModels();
  const existing = installed.findIndex((m) => m.filename === userModel.filename);
  if (existing >= 0) {
    installed[existing] = userModel;
  } else {
    installed.push(userModel);
  }
  saveModelManifest(installed);

  onProgress("Download complete!", 100);
  return userModel;
}

/** Import a local model file by copying it into MODELS_DIR. */
export function importLocalModel(sourcePath: string, name?: string): UserModel {
  const filename = path.basename(sourcePath);
  const dest = path.join(MODELS_DIR, filename);

  if (sourcePath !== dest) {
    fs.copyFileSync(sourcePath, dest);
  }

  const userModel: UserModel = {
    name: name || filename,
    filename,
    source: "local",
    category: inferCategory(filename),
    stemMode: "2-stem",
  };

  const installed = getInstalledModels();
  const existing = installed.findIndex((m) => m.filename === userModel.filename);
  if (existing >= 0) {
    installed[existing] = userModel;
  } else {
    installed.push(userModel);
  }
  saveModelManifest(installed);

  return userModel;
}

/** Delete a model from disk and manifest. */
export function deleteModel(filename: string): void {
  const filePath = path.join(MODELS_DIR, filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best effort */ }

  // Also remove associated config yaml.
  const installed = getInstalledModels();
  const model = installed.find((m) => m.filename === filename);
  if (model?.configFilename) {
    const configPath = path.join(MODELS_DIR, model.configFilename);
    try {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } catch { /* best effort */ }
  }

  const updated = installed.filter((m) => m.filename !== filename);
  saveModelManifest(updated);
}

// --- Internal helpers ---

function parseUvrDownloadChecks(json: any): RemoteModel[] {
  const models: RemoteModel[] = [];

  // VR models: simple name→filename mapping, download from model_repo
  if (json.vr_download_list) {
    for (const [displayName, filename] of Object.entries(json.vr_download_list)) {
      models.push({
        name: displayName.replace(/^VR Arch Single Model v\d+:\s*/, ""),
        filename: filename as string,
        category: "VR",
        stemMode: "2-stem",
        downloads: {
          [filename as string]: `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${filename}`,
        },
      });
    }
  }

  // MDX-Net models: simple name→filename mapping
  if (json.mdx_download_list) {
    for (const [displayName, filename] of Object.entries(json.mdx_download_list)) {
      models.push({
        name: displayName.replace(/^MDX-Net Model:\s*/, ""),
        filename: filename as string,
        category: "MDX-Net",
        stemMode: "2-stem",
        downloads: {
          [filename as string]: `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${filename}`,
        },
      });
    }
  }

  // Demucs models: name→{file: url, ...} mapping
  if (json.demucs_download_list) {
    for (const [displayName, files] of Object.entries(json.demucs_download_list)) {
      const fileMap = files as Record<string, string>;
      const yamlFile = Object.keys(fileMap).find((f) => f.endsWith(".yaml"));
      const stemMode = displayName.includes("6s") ? "6-stem" : "4-stem" as StemMode;
      models.push({
        name: displayName.replace(/^Demucs v\d+:\s*/, ""),
        filename: yamlFile || Object.keys(fileMap)[0],
        category: "Demucs",
        stemMode,
        downloads: fileMap,
      });
    }
  }

  // MDX23C models
  if (json.mdx23c_download_list) {
    for (const [displayName, files] of Object.entries(json.mdx23c_download_list)) {
      const fileMap = files as Record<string, string>;
      const ckptFile = Object.keys(fileMap).find((f) => f.endsWith(".ckpt"));
      models.push({
        name: displayName.replace(/^MDX23C Model:\s*/, ""),
        filename: ckptFile || Object.keys(fileMap)[0],
        category: "MDX23C",
        stemMode: "2-stem",
        downloads: buildMdx23cDownloads(fileMap),
      });
    }
  }

  // Roformer and other models with full URLs
  const networkLists = [
    ...(json.roformer_download_list ? Object.entries(json.roformer_download_list) : []),
  ];
  for (const [displayName, files] of networkLists) {
    const fileMap = files as Record<string, string>;
    const ckptFile = Object.keys(fileMap).find((f) => f.endsWith(".ckpt"));
    models.push({
      name: displayName.replace(/^Roformer Model:\s*/, ""),
      filename: ckptFile || Object.keys(fileMap)[0],
      category: "Roformer",
      stemMode: "2-stem",
      downloads: buildRoformerDownloads(fileMap, displayName),
    });
  }

  // other_network_list and other_network_list_new — already have full URLs
  for (const listKey of ["other_network_list", "other_network_list_new"]) {
    if (!json[listKey]) continue;
    for (const [displayName, files] of Object.entries(json[listKey])) {
      const fileMap = files as Record<string, string>;
      const category = inferCategoryFromName(displayName);
      const stemMode = inferStemModeFromName(displayName);
      const mainFile = Object.keys(fileMap).find((f) => f.endsWith(".ckpt") || f.endsWith(".onnx") || f.endsWith(".pth"))
        || Object.keys(fileMap)[0];
      // Skip if already covered by roformer_download_list
      if (models.some((m) => m.filename === mainFile)) continue;
      models.push({
        name: cleanDisplayName(displayName),
        filename: mainFile,
        category,
        stemMode,
        downloads: fileMap,
      });
    }
  }

  return models;
}

function buildMdx23cDownloads(fileMap: Record<string, string>): Record<string, string> {
  // MDX23C: key is ckpt filename, value is config yaml filename
  // Both need downloading from TRvlvr repos
  const downloads: Record<string, string> = {};
  for (const [ckpt, configName] of Object.entries(fileMap)) {
    downloads[ckpt] = `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${ckpt}`;
    downloads[configName] = `https://raw.githubusercontent.com/TRvlvr/application_data/main/mdx_model_data/mdx_c_configs/${configName}`;
  }
  return downloads;
}

function buildRoformerDownloads(fileMap: Record<string, string>, displayName: string): Record<string, string> {
  // roformer_download_list: key is ckpt filename, value is config yaml filename
  // Both are on TRvlvr repos
  const downloads: Record<string, string> = {};
  for (const [ckpt, configName] of Object.entries(fileMap)) {
    downloads[ckpt] = `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${ckpt}`;
    downloads[configName] = `https://raw.githubusercontent.com/TRvlvr/application_data/main/mdx_model_data/mdx_c_configs/${configName}`;
  }
  return downloads;
}

function inferCategory(filename: string): ModelCategory {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".onnx")) return "MDX-Net";
  if (lower.endsWith(".pth")) return "VR";
  if (lower.includes("roformer")) return "Roformer";
  if (lower.includes("demucs") || lower.includes("htdemucs")) return "Demucs";
  if (lower.includes("mdx23c")) return "MDX23C";
  return "Other";
}

function inferCategoryFromName(displayName: string): ModelCategory {
  if (displayName.startsWith("Roformer Model")) return "Roformer";
  if (displayName.startsWith("MDX23C Model")) return "MDX23C";
  if (displayName.startsWith("MDX-Net Model")) return "MDX-Net";
  if (displayName.startsWith("VR Arch")) return "VR";
  if (displayName.includes("Demucs") || displayName.includes("demucs")) return "Demucs";
  if (displayName.includes("Bandit") || displayName.includes("SCnet")) return "Other";
  return "Other";
}

function inferStemModeFromName(displayName: string): StemMode {
  if (displayName.includes("6-stem") || displayName.includes("6stem")) return "6-stem";
  if (displayName.includes("4-stem") || displayName.includes("4stem") || displayName.includes("fourstem")) return "4-stem";
  return "2-stem";
}

function cleanDisplayName(name: string): string {
  return name
    .replace(/^(Roformer Model|MDX23C Model|MDX-Net Model|VR Arch Single Model v\d+|Bandit Plus|Bandit v2|SCnet):\s*/, "")
    .trim();
}

/** Fetch JSON from a URL. */
function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "ableton-uvr-extension" } }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse JSON from ${url}: ${err}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

/** Download a file from URL to disk. */
function downloadFile(url: string, dest: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Cancelled")); return; }

    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "ableton-uvr-extension" } }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest, signal).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }

      const tempDest = dest + ".tmp";
      const file = fs.createWriteStream(tempDest);

      const abortHandler = () => {
        file.close();
        try { fs.unlinkSync(tempDest); } catch { /* ignore */ }
        reject(new Error("Download cancelled"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      res.pipe(file);
      file.on("finish", () => {
        signal.removeEventListener("abort", abortHandler);
        file.close(() => {
          try {
            fs.renameSync(tempDest, dest);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      file.on("error", (err) => {
        signal.removeEventListener("abort", abortHandler);
        file.close();
        try { fs.unlinkSync(tempDest); } catch { /* ignore */ }
        reject(err);
      });
    });
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}
