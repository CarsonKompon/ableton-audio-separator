import {
  initialize,
  AudioTrack,
  AudioClip,
  type ActivationContext,
  type Handle,
  type ArrangementSelection,
} from "@ableton-extensions/sdk";

import {
  checkAudioSeparatorAvailable,
  installAudioSeparator,
  logEnvironmentInfo,
  separateAudio,
  cleanupTempFiles,
  type SeparationConfig,
} from "./separator.js";
import { importStemsAndCreateTracks } from "./tracks.js";

// esbuild inlines this HTML file as a string.
import settingsHtml from "../ui/settings.html";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // --- Startup check for audio-separator availability ---
  checkAudioSeparatorAvailable().then(async (version) => {
    if (version) {
      console.log(`[UVR] audio-separator found: ${version}`);
      const envInfo = await logEnvironmentInfo();
      console.log(`[UVR] Environment:\n${envInfo}`);
    } else {
      console.warn(
        "[UVR] audio-separator not found. " +
        "It will be installed into a local venv on first use."
      );
    }
  });

  // --- Command: Separate from AudioClip context menu ---
  context.commands.registerCommand(
    "uvr.separateClip",
    async (...args: unknown[]) => {
      const handle = args[0] as Handle;
      const clip = context.getObjectFromHandle(handle, AudioClip);
      const filePath = clip.filePath;
      const startTime = clip.startTime;
      const duration = clip.duration;

      // Find the parent track name for labeling.
      const trackName = findParentTrackName(clip, context) ?? "Audio";

      await showSettingsAndSeparate(filePath, startTime, duration, trackName);
    },
  );

  // --- Command: Separate from Arrangement Selection context menu ---
  context.commands.registerCommand(
    "uvr.separateSelection",
    async (...args: unknown[]) => {
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

      // Render the selection to a temp WAV file.
      await context.ui.withinProgressDialog(
        "Rendering audio...",
        {},
        async (update, signal) => {
          update("Rendering pre-FX audio from arrangement...", undefined);
          signal.throwIfAborted();

          const renderedPath = await context.resources.renderPreFxAudio(
            track, start, end,
          );

          const duration = end - start;
          await showSettingsAndSeparate(renderedPath, start, duration, trackName);
        },
      );
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

  // --- Core workflow: show settings dialog then run separation ---
  async function showSettingsAndSeparate(
    inputFilePath: string,
    startTimeBeats: number,
    durationBeats: number,
    sourceTrackName: string,
  ): Promise<void> {
    // Check audio-separator is available before showing UI.
    const version = await checkAudioSeparatorAvailable();
    if (!version) {
      // Offer to install audio-separator for the user.
      const installHtml = `
        <html><body style="font-family:sans-serif;background:#1e1e1e;color:#e0e0e0;padding:20px;">
        <h2 style="color:#ff6b00;">audio-separator not found</h2>
        <p style="margin:12px 0;">This extension requires <strong>audio-separator</strong> (Python package) to separate stems.</p>
        <p style="margin:8px 0;color:#999;">Would you like to install it now?</p>
        <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
          <button onclick="send('cancel')" style="padding:8px 16px;background:#2a2a2a;border:1px solid #3a3a3a;color:#e0e0e0;border-radius:4px;cursor:pointer;">Cancel</button>
          <button onclick="send('install-cpu')" style="padding:8px 16px;background:#333;border:1px solid #3a3a3a;color:#e0e0e0;border-radius:4px;cursor:pointer;">Install (CPU only)</button>
          <button onclick="send('install-gpu')" style="padding:8px 16px;background:#ff6b00;border:none;color:#fff;border-radius:4px;cursor:pointer;">Install (GPU)</button>
        </div>
        <script>function send(v){const m={method:"close_and_send",params:[v]};if(window.webkit?.messageHandlers?.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome?.webview)window.chrome.webview.postMessage(m);}</script>
        </body></html>`;
      const installUrl = `data:text/html,${encodeURIComponent(installHtml)}`;
      const installResult = await context.ui.showModalDialog(installUrl, 460, 200);

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

    if (!result) return;

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
      return;
    }

    // Run separation with progress dialog.
    await context.ui.withinProgressDialog(
      "Separating Stems",
      {},
      async (update, signal) => {
        update("Initializing...", 0);

        const separationResult = await separateAudio(
          inputFilePath,
          config,
          (message, percentage) => {
            update(message, percentage);
          },
          signal,
        );

        // Import stems and create tracks.
        update("Importing stems into project...", undefined);
        signal.throwIfAborted();

        await importStemsAndCreateTracks(
          context as unknown as Parameters<typeof importStemsAndCreateTracks>[0],
          separationResult,
          { sourceTrackName, startTimeBeats, durationBeats },
        );

        // Clean up temp files.
        update("Cleaning up...", undefined);
        await cleanupTempFiles(separationResult.stems);

        update("Done!", 100);
      },
    );
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
  try {
    const song = context.application.song;
    for (const track of song.tracks) {
      if (track instanceof AudioTrack) {
        const clips = track.arrangementClips;
        for (const c of clips) {
          if (c === clip) return track.name;
        }
      }
    }
  } catch {
    // Best effort — SDK may not support this traversal pattern.
  }
  return null;
}
