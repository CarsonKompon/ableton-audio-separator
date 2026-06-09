import {
  initialize,
  AudioTrack,
  AudioClip,
  type ActivationContext,
  type Handle,
  type ArrangementSelection,
} from "@ableton-extensions/sdk";

import * as path from "node:path";

import {
  checkAudioSeparatorAvailable,
  installAudioSeparator,
  logEnvironmentInfo,
  getPaths,
  initPaths,
  checkStorageVersion,
  separateAudio,
  cleanupTempFiles,
  type SeparationConfig,
  type SeparationResult,
} from "./separator.js";
import { importStemsAndCreateTracks } from "./tracks.js";

// esbuild inlines this HTML file as a string.
import settingsHtml from "../ui/settings.html";

export function activate(activation: ActivationContext) {
  let context: ReturnType<typeof initialize>;
  try {
    context = initialize(activation, "1.0.0");
  } catch (err) {
    console.error("[UVR] Failed to initialize SDK:", err);
    return;
  }

  // Initialize filesystem paths using SDK-provided directories.
  let pathsReady = false;
  try {
    const storageDir = context.environment.storageDirectory;
    const tempDir = context.environment.tempDirectory;
    if (storageDir && tempDir) {
      initPaths(storageDir, tempDir);
      checkStorageVersion();
      pathsReady = true;
      console.log("[UVR] Paths initialized:", JSON.stringify(getPaths(), null, 2));
    } else {
      // Fall back to OS temp directories if SDK doesn't provide them.
      const os = require("node:os") as typeof import("node:os");
      const fallbackStorage = path.join(os.tmpdir(), "ableton-uvr-storage");
      const fallbackTemp = path.join(os.tmpdir(), "ableton-uvr-temp");
      console.warn(`[UVR] SDK directories not available (storage=${storageDir}, temp=${tempDir}). Using fallback: ${fallbackStorage}`);
      initPaths(fallbackStorage, fallbackTemp);
      checkStorageVersion();
      pathsReady = true;
    }
  } catch (err) {
    console.error("[UVR] Failed to init paths:", err);
  }

  // --- Startup check (only if paths are configured) ---
  if (pathsReady) {
    checkAudioSeparatorAvailable().then(async (version) => {
      if (version) {
        console.log(`[UVR] audio-separator found: ${version}`);
      } else {
        console.warn("[UVR] audio-separator not found. Will install on first use.");
      }
    }).catch((err) => {
      console.error("[UVR] Startup check failed:", err);
    });
  }

  // --- Command: Separate from AudioClip context menu ---
  context.commands.registerCommand(
    "uvr.separateClip",
    async (...args: unknown[]) => {
      try {
        const handle = args[0] as Handle;
        const clip = context.getObjectFromHandle(handle, AudioClip);
        const startTime = clip.startTime;
        const endTime = clip.endTime;
        const duration = endTime - startTime;

        // Find the parent track to render from.
        const trackName = findParentTrackName(clip, context) ?? "Audio";
        const parentTrack = findParentTrack(clip, context);
        if (!parentTrack) {
          await showErrorDialog("Could not find the parent track for this clip.");
          return;
        }

        await showSettingsAndSeparate(parentTrack, startTime, endTime, duration, trackName);
      } catch (err) {
        console.error("[UVR] Error in separateClip:", err);
        await showErrorDialog(`Clip separation failed: ${err}`);
      }
    },
  );

  // --- Command: Separate from Arrangement Selection context menu ---
  context.commands.registerCommand(
    "uvr.separateSelection",
    async (...args: unknown[]) => {
      try {
        const selection = args[0] as ArrangementSelection;
        const start = selection.time_selection_start;
        const end = selection.time_selection_end;

        if (selection.selected_lanes.length === 0) {
          console.error("[UVR] No tracks selected in arrangement.");
          return;
        }

        // Use the first selected lane/track for rendering.
        const trackHandle = selection.selected_lanes[0];
        const track = context.getObjectFromHandle(trackHandle, AudioTrack);
        const trackName = track.name ?? "Audio";
        const duration = end - start;

        await showSettingsAndSeparate(track, start, end, duration, trackName);
      } catch (err) {
        console.error("[UVR] Error in separateSelection:", err);
        await showErrorDialog(`Selection separation failed: ${err}`);
      }
    },
  );

  // --- Register context menu actions ---
  context.ui.registerContextMenuAction(
    "AudioClip",
    "Separate Clip Stems (UVR)",
    "uvr.separateClip",
  );

  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Separate Selection Stems (UVR)",
    "uvr.separateSelection",
  );

  // --- Helper: show a visible error dialog to the user ---
  async function showErrorDialog(message: string): Promise<void> {
    const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const html = `<html><head><style>
      *,*::before,*::after{box-sizing:border-box}*{margin:0}
      :root{--bg:hsl(0,0%,21%);--text:hsl(0,0%,71%);--text2:hsl(0,0%,41%);--ctrl:hsl(0,0%,16%);--border:hsl(0,0%,7%);--input:hsl(0,0%,12%);--accent:hsl(31,100%,67%);--fg:hsl(0,0%,7%)}
      html{background:var(--bg);color:var(--text);font-family:"AbletonSansSmall",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11.5px;font-weight:500;-webkit-font-smoothing:antialiased;height:100%}
      body{padding:1.5em;height:100%;display:flex;flex-direction:column;justify-content:center}
      h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:hsl(0,70%,55%);margin-bottom:0.75em}
      pre{white-space:pre-wrap;word-break:break-all;font-size:11px;background:var(--input);color:var(--text);padding:0.75em;border:1px solid var(--border);max-height:140px;overflow:auto;margin-bottom:1em;font-family:monospace}
      .actions{display:flex;justify-content:flex-end}
      .btn{font-size:1rem;line-height:1;background:var(--ctrl);color:var(--text);border:1px solid var(--border);height:22px;padding:0 1.25em;border-radius:1em;cursor:pointer;user-select:none}
      .btn:hover{background:hsl(0,0%,14%)}
      .btn:active{color:var(--fg);background:var(--accent)}
    </style></head><body>
      <h2>Error</h2>
      <pre>${escaped}</pre>
      <div class="actions">
        <button class="btn" onclick="(function(){var m={method:'close_and_send',params:['ok']};if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);})()">OK</button>
      </div></body></html>`;
    try {
      await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 460, 260);
    } catch {
      // If even this dialog fails, just log it.
    }
  }

  // --- Core workflow: show settings dialog then run separation ---
  async function showSettingsAndSeparate(
    sourceTrack: InstanceType<typeof AudioTrack>,
    startTimeBeats: number,
    endTimeBeats: number,
    durationBeats: number,
    sourceTrackName: string,
  ): Promise<void> {
    if (!pathsReady) {
      await showErrorDialog("Extension paths not configured. storageDirectory or tempDirectory unavailable.");
      return;
    }

    // Check audio-separator is available before showing UI.
    const version = await checkAudioSeparatorAvailable();
    if (!version) {
      // Offer to install audio-separator for the user.
      const installHtml = `
        <html><head><style>
          *,*::before,*::after{box-sizing:border-box}*{margin:0}
          :root{--bg:hsl(0,0%,21%);--text:hsl(0,0%,71%);--text2:hsl(0,0%,41%);--ctrl:hsl(0,0%,16%);--border:hsl(0,0%,7%);--input:hsl(0,0%,12%);--accent:hsl(31,100%,67%);--fg:hsl(0,0%,7%)}
          html{background:var(--bg);color:var(--text);font-family:"AbletonSansSmall",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11.5px;font-weight:500;-webkit-font-smoothing:antialiased;height:100%}
          body{padding:1.5em;height:100%;display:flex;flex-direction:column;justify-content:center}
          h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);margin-bottom:0.75em}
          p{line-height:1.6;margin-bottom:0.5em}
          .muted{color:var(--text2)}
          .actions{display:flex;gap:0.5em;margin-top:1.25em;justify-content:flex-end}
          .btn{font-size:1rem;line-height:1;background:var(--ctrl);color:var(--text);border:1px solid var(--border);height:22px;padding:0 1.25em;border-radius:1em;cursor:pointer;user-select:none;white-space:nowrap}
          .btn:hover{background:hsl(0,0%,14%)}
          .btn:active{color:var(--fg);background:var(--accent)}
          .btn--primary{background:var(--accent);color:var(--fg);border-color:var(--accent)}
          .btn--primary:hover{background:hsl(31,100%,60%)}
        </style></head><body>
        <h2>audio-separator not found</h2>
        <p>This extension requires <strong>audio-separator</strong> to separate stems. It will be installed automatically via <strong>uv</strong> (Python package manager).</p>
        <p class="muted">Would you like to install it now?</p>
        <div class="actions">
          <button class="btn" onclick="send('cancel')">Cancel</button>
          <button class="btn" onclick="send('install-cpu')">Install (CPU only)</button>
          <button class="btn btn--primary" onclick="send('install-gpu')">Install (GPU)</button>
        </div>
        <script>function send(v){const m={method:"close_and_send",params:[v]};if(window.webkit?.messageHandlers?.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome?.webview)window.chrome.webview.postMessage(m);}</script>
        </body></html>`;
      const installUrl = `data:text/html,${encodeURIComponent(installHtml)}`;
      const installResult = await context.ui.showModalDialog(installUrl, 460, 220);

      if (!installResult || installResult === "cancel") return;

      const useGpu = installResult === "install-gpu";

      // Run pip install with progress dialog.
      let installSuccess = false;
      try {
        await context.ui.withinProgressDialog(
          "Installing audio-separator",
          {},
          async (update, signal) => {
            await installAudioSeparator(useGpu, update, signal);
            installSuccess = true;
          },
        );
      } catch (err) {
        console.error("[UVR] Installation failed:", err);
        return;
      }

      if (!installSuccess) return;

      // Verify it's now available.
      const check = await checkAudioSeparatorAvailable();
      if (!check) {
        console.error("[UVR] audio-separator still not found after installation.");
        return;
      }
    }

    // Show the settings modal dialog.
    const settingsUrl = `data:text/html,${encodeURIComponent(settingsHtml)}`;
    const result = await context.ui.showModalDialog(settingsUrl, 440, 480);

    console.log("[UVR] Dialog result:", JSON.stringify(result));

    if (!result) {
      console.log("[UVR] Dialog returned empty result (cancelled or closed).");
      return;
    }

    let config: SeparationConfig;
    try {
      const parsed = JSON.parse(result);
      if (parsed.action === "cancel" || !parsed.action) return;
      config = {
        mode: parsed.mode,
        modelFilename: parsed.modelFilename,
        outputFormat: parsed.outputFormat,
        useGpu: parsed.useGpu,
      };
    } catch {
      console.error("[UVR] Failed to parse dialog result:", result);
      await showErrorDialog(`Failed to parse settings: ${result}`);
      return;
    }

    console.log("[UVR] Starting separation with config:", JSON.stringify(config));

    // Run render + separation + import in a single progress dialog.
    let separationResult: SeparationResult | null = null as SeparationResult | null;
    try {
      await context.ui.withinProgressDialog(
        "Separating Stems",
        {},
        async (update, signal) => {
          // Phase 1: Render audio (0-10% is reserved for this).
          await update("Rendering audio...", 0);
          signal.throwIfAborted();

          const inputFilePath = await context.resources.renderPreFxAudio(
            sourceTrack, startTimeBeats, endTimeBeats,
          );

          console.log("[UVR] Rendered audio to:", inputFilePath);

          // Phase 2: Separate stems (10-95%).
          await update("Initializing separation...", 10);

          separationResult = await separateAudio(
            inputFilePath,
            config,
            (message, percentage) => {
              // separator.ts already returns normalized percentages in 10-95% range
              Promise.resolve(update(message, percentage)).catch(() => {});
            },
            signal,
          );

          // Phase 3: Import and create tracks (95-100%).
          await update("Creating tracks...", 95);

          if (separationResult) {
            const finalResult: SeparationResult = separationResult;
            const stemNames = [...finalResult.stems.keys()];
            console.log("[UVR] Stems to import:", stemNames);

            if (stemNames.length < 2 && config.mode !== "2-stem") {
              const stemDetails = [...finalResult.stems.entries()]
                .map(([name, p]) => `${name}: ${path.basename(p)}`)
                .join("\n");
              await showErrorDialog(
                `Expected multiple stems for ${config.mode} but only found ${stemNames.length}:\n${stemDetails}\n\n` +
                `This may be a model output naming issue. The separation files are in the temp directory.`
              );
              return;
            }

            // Use withinTransaction to group all track creation as a single undo step.
            const trackPromises = context.withinTransaction(() => {
              return importStemsAndCreateTracks(
                context as unknown as Parameters<typeof importStemsAndCreateTracks>[0],
                finalResult,
                { sourceTrackName, startTimeBeats, durationBeats },
              );
            });
            await trackPromises;
          }

          await update("Done!", 100);
        },
      );
    } catch (err) {
      console.error("[UVR] Separation failed:", err);
      await showErrorDialog(`Separation failed: ${err}`);
      return;
    }

    // Clean up temp files.
    if (separationResult) {
      try {
        await cleanupTempFiles((separationResult as SeparationResult).stems);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/**
 * Attempts to find the name of the parent track for a given clip.
 * Falls back to null if not determinable.
 */
function findParentTrackName(
  clip: InstanceType<typeof AudioClip>,
  context: ReturnType<typeof initialize>,
): string | null {
  const track = findParentTrack(clip, context);
  return track?.name ?? null;
}

/**
 * Attempts to find the parent AudioTrack for a given clip.
 */
function findParentTrack(
  clip: InstanceType<typeof AudioClip>,
  context: ReturnType<typeof initialize>,
): InstanceType<typeof AudioTrack> | null {
  try {
    const song = context.application.song;
    for (const track of song.tracks) {
      if (track instanceof AudioTrack) {
        const clips = track.arrangementClips;
        for (const c of clips) {
          if (c === clip) return track;
        }
      }
    }
  } catch {
    // Best effort — SDK may not support this traversal pattern.
  }
  return null;
}
