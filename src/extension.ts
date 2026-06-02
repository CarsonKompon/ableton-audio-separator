import { initialize, type ActivationContext } from "@ableton-extensions/sdk";

// esbuild inlines this HTML file as a string for production builds.
import bundledInterface from "../ui/interface.html";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand("ableton-uvr-extension.showDialog", () => {
    const url = `data:text/html,${encodeURIComponent(bundledInterface)}`;
    context.ui.showModalDialog(url, 320, 160).then((result) => {
      console.log(`Dialog closed with: ${result}`);
    });
  });

  context.ui.registerContextMenuAction(
    "AudioClip",
    "Open ableton-uvr-extension",
    "ableton-uvr-extension.showDialog",
  );
}
