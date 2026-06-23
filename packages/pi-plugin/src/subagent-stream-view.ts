/**
 * Full-screen TUI overlay that streams subagent (historian/dreamer/sidekick)
 * progress events live. Scrollable, auto-scrolls to bottom while running.
 *
 * Modeled on pi-subagents' ConversationViewer — same viewport/scroll pattern.
 *
 * IMPORTANT: Pi's print mode (via session.subscribe) only emits `message_start`
 * and `message_end` events — NOT `message_update` (streaming deltas). So the
 * model's output only becomes available when the full message is complete.
 * We show a "generating..." indicator on `message_start` and the full output
 * on `message_end`. Thinking/reasoning blocks are extracted if present.
 */

import {
	type Component,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentProgressEvent } from "@magic-context/core/shared/subagent-runner";
import { getStreamBus } from "./subagent-stream-bus";

interface Theme {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 100;
/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
const MAX_OUTPUT_LINES = 2000;

/** Extract content parts from a message, including text and thinking. */
function extractContentParts(content: unknown[]): { text: string; thinking: string } {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	for (const block of content) {
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			textParts.push(b.text);
		} else if (b.type === "thinking") {
			// Pi stores thinking content in `block.thinking`, NOT `block.text`
			const thinkingText = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
			if (thinkingText) thinkingParts.push(thinkingText);
		} else if (b.type === "reasoning") {
			const reasoningText = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
			if (reasoningText) thinkingParts.push(reasoningText);
		}
	}
	return {
		text: textParts.filter(Boolean).join("\n"),
		thinking: thinkingParts.filter(Boolean).join("\n"),
	};
}

interface ExtractedOutput {
	text: string;
	thinking: string;
	generating: boolean;
	lastEventTypes: string[];
}

function extractStreamingOutput(events: SubagentProgressEvent[]): ExtractedOutput {
	let text = "";
	let thinking = "";
	let generating = false;
	const lastEventTypes: string[] = [];

	for (const event of events) {
		if (event.type !== "raw_event") continue;
		const e = event.event as Record<string, unknown>;
		const eventType = typeof e.type === "string" ? e.type : "unknown";
		lastEventTypes.push(eventType);
		// Keep only last 20 event types for diagnostics
		if (lastEventTypes.length > 20) lastEventTypes.shift();

		// message_start with role "assistant" = model is generating
		if (e.type === "message_start") {
			const msg = e.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant") {
				generating = true;
			}
		}

		// message_end with role "assistant" = full output available
		if (e.type === "message_end") {
			const msg = e.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant" && msg.content && Array.isArray(msg.content)) {
				const extracted = extractContentParts(msg.content);
				if (extracted.text) text = extracted.text;
				if (extracted.thinking) thinking = extracted.thinking;
				generating = false;
			}
		}

		// message_update = streaming deltas. Check BOTH message.content
		// AND assistantMessageEvent.partial.content independently —
		// thinking may be in partial.content while text is in message.content.
		if (e.type === "message_update") {
			const msg = e.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant" && msg.content && Array.isArray(msg.content)) {
				const extracted = extractContentParts(msg.content);
				if (extracted.text) text = extracted.text;
				if (extracted.thinking) thinking = extracted.thinking;
			}
			// ALWAYS check assistantMessageEvent.partial.content, even if
			// message.content already set text — thinking blocks often live
			// here, not in message.content during streaming.
			const ame = e.assistantMessageEvent as Record<string, unknown> | undefined;
			if (ame) {
				const partial = ame.partial as Record<string, unknown> | undefined;
				if (partial?.content && Array.isArray(partial.content)) {
					const extracted = extractContentParts(partial.content);
					if (extracted.text) text = extracted.text;
					if (extracted.thinking) thinking = extracted.thinking;
				}
				// Also accumulate text_delta deltas as a last resort
				if (ame.type === "text_delta" && typeof ame.delta === "string" && !text) {
					let accumulated = "";
					for (const e2 of events) {
						if (e2.type !== "raw_event") continue;
						const ev = e2.event as Record<string, unknown>;
						if (ev.type !== "message_update") continue;
						const ame2 = ev.assistantMessageEvent as Record<string, unknown> | undefined;
						if (ame2?.type === "text_delta" && typeof ame2.delta === "string") {
							accumulated += ame2.delta;
						}
					}
					if (accumulated) text = accumulated;
				}
			}
		}
	}
	return { text, thinking, generating, lastEventTypes };
}

function buildTimeline(
	events: SubagentProgressEvent[],
	t: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	for (const event of events) {
		switch (event.type) {
			case "spawned":
				lines.push(
					`  ${t.fg("accent", "▶ spawned")} pid=${event.pid ?? "?"} argv=${event.argv.length}`,
				);
				break;
			case "stderr": {
				const cleaned = event.chunk.replace(/\s+/g, " ").trim();
				if (cleaned.length > 0) {
					lines.push(
						`  ${t.fg("warning", "⚠ stderr")} ${truncateToWidth(cleaned, Math.max(10, width - 14))}`,
					);
				}
				break;
			}
			case "terminal":
				lines.push(
					`  ${t.fg("success", "● terminal")} stopReason=${event.stopReason ?? "?"} textLen=${event.textLength}`,
				);
				break;
			case "child_exit":
				lines.push(
					`  ${event.code === 0 ? t.fg("success", "✓ exited") : t.fg("error", "✗ exited")} code=${event.code} signal=${event.signal ?? "none"}`,
				);
				break;
		}
	}
	return lines;
}

export interface StreamViewerOptions {
	tui: TUI;
	theme: Theme;
	done: (result: undefined) => void;
}

export class StreamViewer implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private unsubscribe: (() => void) | undefined;
	private lastInnerW = 0;
	private closed = false;

	private tui: TUI;
	private theme: Theme;
	private done: (result: undefined) => void;

	constructor({ tui, theme, done }: StreamViewerOptions) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		const bus = getStreamBus();
		this.unsubscribe = bus.subscribe(() => {
			if (this.closed) return;
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.closed = true;
			this.done(undefined);
			return;
		}

		const totalLines = this.buildContentLines(this.lastInnerW).length;
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, totalLines - viewportHeight);

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
			this.autoScroll = false;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
		}
	}

	render(width: number): string[] {
		if (width < 6) return [];
		const th = this.theme;
		const innerW = width;
		this.lastInnerW = innerW;
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => truncateToWidth(pad(content, innerW), innerW);
		const hrMid = th.fg("dim", "─".repeat(innerW));

		// Header
		const bus = getStreamBus();
		const run = bus.getCurrentRun();

		if (!run) {
			lines.push(`${th.bold("Magic Context Subagent Stream")} ${th.fg("dim", "· /mc-stream")}`);
			lines.push(hrMid);
			lines.push("");
			lines.push(th.fg("dim", "No subagent runs yet."));
			lines.push(th.fg("dim", "The historian/dreamer/sidekick stream will appear here."));
			lines.push("");
			lines.push(th.fg("dim", "Run /ctx-recomp or wait for the historian to auto-trigger."));
			lines.push(hrMid);
			lines.push(th.fg("dim", "Esc/q close"));
			return lines;
		}

		const statusIcon = run.status === "running"
			? th.fg("accent", "●")
			: run.status === "ok" ? th.fg("success", "✓") : th.fg("error", "✗");
		const statusText = run.status === "running" ? "RUNNING" : run.status === "ok" ? "DONE" : "FAILED";
		const elapsed = run.endedAt
			? ((run.endedAt - run.startedAt) / 1000).toFixed(1)
			: ((Date.now() - run.startedAt) / 1000).toFixed(1);
		const modelPart = run.model ? ` ${th.fg("dim", "·")} ${th.fg("dim", run.model)}` : "";

		lines.push(
			`${statusIcon} ${th.bold(run.label)} ${th.fg("dim", "·")} ${statusText} ${th.fg("dim", "·")} ${elapsed}s${modelPart}`,
		);
		lines.push(hrMid);

		// Content area
		const contentLines = this.buildContentLines(innerW);
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, contentLines.length - viewportHeight);

		if (this.autoScroll) {
			this.scrollOffset = maxScroll;
		}

		const visibleStart = Math.min(this.scrollOffset, maxScroll);
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

		for (let i = 0; i < viewportHeight; i++) {
			lines.push(row(visible[i] ?? ""));
		}

		// Footer
		lines.push(hrMid);
		const scrollPct =
			contentLines.length <= viewportHeight
				? "100%"
				: `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
		const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
		const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · Esc close");
		const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
		lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));

		return lines;
	}

	invalidate(): void {
		/* no cached state to clear */
	}

	dispose(): void {
		this.closed = true;
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	// ---- Private ----

	private viewportHeight(): number {
		// Full terminal height minus header (2 lines: status + separator)
		// and footer (2 lines: separator + footer)
		const chrome = 4;
		return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - chrome);
	}

	private buildContentLines(width: number): string[] {
		if (width <= 0) return [];

		const th = this.theme;
		const bus = getStreamBus();
		const run = bus.getCurrentRun();
		if (!run) return [];

		const lines: string[] = [];

		// Timeline
		const timeline = buildTimeline(run.events, th, width);
		lines.push(...timeline);

		// Extract output from events
		const output = extractStreamingOutput(run.events);

		if (output.thinking.length > 0) {
			lines.push("");
			lines.push(th.fg("muted", "── Thinking ──"));
			const thinkingLines = output.thinking.split("\n").slice(-MAX_OUTPUT_LINES);
			for (const line of thinkingLines) {
				lines.push(th.fg("dim", line));
			}
		}

		if (output.text.length > 0) {
			lines.push("");
			lines.push(th.fg("accent", "── Output ──"));
			const textLines = output.text.split("\n").slice(-MAX_OUTPUT_LINES);
			for (const line of textLines) {
				lines.push(line);
			}
		} else if (run.status === "running") {
			lines.push("");
			lines.push(th.fg("dim", "Waiting for model output..."));
			if (output.lastEventTypes.length > 0) {
				lines.push(th.fg("dim", `  Events seen: ${output.lastEventTypes.join(", ")}`));
			}
		}

		return lines.map((l) => truncateToWidth(l, width));
	}
}
