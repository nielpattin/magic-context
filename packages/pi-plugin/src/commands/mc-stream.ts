/**
 * /mc-stream — open a full-screen TUI view that streams the live
 * historian/dreamer/sidekick subagent process.
 *
 * Uses an overlay positioned at center with 90% width and 80% height.
 * Esc/q closes the view; the subagent keeps running in the background.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	StreamViewer,
	VIEWPORT_HEIGHT_PCT,
} from "../subagent-stream-view";

export function registerMcStreamCommand(pi: ExtensionAPI): void {
	pi.registerCommand("mc-stream", {
		description: "Stream live Magic Context subagent (historian/dreamer) output",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				pi.sendMessage(
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "/mc-stream requires an interactive TUI session.",
							},
						],
					},
					{ triggerTurn: false },
				);
				return;
			}

			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					return new StreamViewer({
						tui,
						theme,
						done,
					});
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "100%",
						maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
					},
				},
			);
		},
	});
}
