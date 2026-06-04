import type { SeparationResult } from "./separator.js";

/**
 * Handles importing separated stem files into the Ableton project and creating
 * new audio tracks with clips placed at the original position.
 *
 * This module is generic over the SDK context type to avoid directly importing
 * SDK internals — the context is passed in from extension.ts.
 */

export interface TrackPlacementOptions {
  /** Original track name (used as prefix for new stem tracks). */
  sourceTrackName: string;
  /** Beat position where the original clip/selection started. */
  startTimeBeats: number;
  /** Duration in beats of the original clip/selection. */
  durationBeats: number;
}

/**
 * Imports all stem files into the project and creates new audio tracks.
 *
 * @param context - The Ableton Extensions SDK context object.
 * @param result - The separation result containing stem file paths.
 * @param options - Placement options (source name, position, duration).
 */
export async function importStemsAndCreateTracks(
  context: {
    resources: { importIntoProject(filePath: string): Promise<string> };
    application: { song: { createAudioTrack(): Promise<{ name: string; createAudioClip(args: { filePath: string; startTime: number; isWarped?: boolean }): Promise<unknown> }> } };
  },
  result: SeparationResult,
  options: TrackPlacementOptions,
): Promise<void> {
  // Import all stem files into the project first.
  const importedStems = new Map<string, string>();
  for (const [stemName, filePath] of result.stems) {
    console.log(`[UVR] Importing stem "${stemName}" from: ${filePath}`);
    const projectPath = await context.resources.importIntoProject(filePath);
    console.log(`[UVR] Imported "${stemName}" → ${projectPath}`);
    importedStems.set(stemName, projectPath);
  }

  // Create tracks and place clips sequentially.
  for (const [stemName, projectPath] of importedStems) {
    console.log(`[UVR] Creating track for "${stemName}"`);
    const track = await context.application.song.createAudioTrack();
    track.name = `${options.sourceTrackName} — ${stemName}`;

    console.log(`[UVR] Creating clip on track "${track.name}" at beat ${options.startTimeBeats}`);
    await track.createAudioClip({
      filePath: projectPath,
      startTime: options.startTimeBeats,
      isWarped: false,
    });
    console.log(`[UVR] Successfully created clip for "${stemName}"`);
  }
}
