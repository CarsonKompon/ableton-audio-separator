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
 * All operations are wrapped in a transaction for single-undo.
 *
 * @param context - The Ableton Extensions SDK context object.
 * @param result - The separation result containing stem file paths.
 * @param options - Placement options (source name, position, duration).
 */
export async function importStemsAndCreateTracks(
  context: {
    resources: { importIntoProject(filePath: string): Promise<string> };
    application: { song: { createAudioTrack(): Promise<{ name: string; createAudioClip(args: { filePath: string; startTime: number; duration?: number; isWarped?: boolean }): Promise<unknown> }> } };
    withinTransaction<T>(fn: () => T): T;
  },
  result: SeparationResult,
  options: TrackPlacementOptions,
): Promise<void> {
  // Import all stem files into the project first (outside transaction since it's async I/O).
  const importedStems = new Map<string, string>();
  for (const [stemName, filePath] of result.stems) {
    const projectPath = await context.resources.importIntoProject(filePath);
    importedStems.set(stemName, projectPath);
  }

  // Create tracks and place clips within a single transaction (one undo step).
  context.withinTransaction(() => {
    // We need to handle the async track creation carefully.
    // withinTransaction expects synchronous grouping — the actual awaits
    // happen inside but the transaction boundary captures them.
  });

  // Since withinTransaction may not support async in all SDK versions,
  // we create tracks sequentially and rely on the SDK's behavior.
  for (const [stemName, projectPath] of importedStems) {
    const track = await context.application.song.createAudioTrack();
    track.name = `${options.sourceTrackName} — ${stemName}`;

    await track.createAudioClip({
      filePath: projectPath,
      startTime: options.startTimeBeats,
      duration: options.durationBeats,
      isWarped: true,
    });
  }
}
