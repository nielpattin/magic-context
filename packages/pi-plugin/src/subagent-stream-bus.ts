/**
 * Singleton event bus for streaming subagent (historian/dreamer/sidekick)
 * progress events to TUI subscribers.
 *
 * The subagent runner spawns child Pi processes that emit NDJSON events on
 * stdout. The runner's `onProgress` callback forwards parsed events here so
 * any subscribed TUI component can render them live. Events are also buffered
 * so a subscriber that opens mid-run sees the full history.
 *
 * Architecture:
 *   subagent-runner.ts  →  onProgress  →  SubagentStreamBus.publish()
 *                                                  ↓
 *   /mc-stream command  →  SubagentStreamView subscribes  →  live render
 *
 * The bus is a process-global singleton (one Pi process = one bus). Multiple
 * concurrent subagent runs are distinguished by `runId`.
 */

import type { SubagentProgressEvent } from "@magic-context/core/shared/subagent-runner";

export interface StreamEntry {
	/** Unique ID for this subagent run (historian pass, dreamer, etc.). */
	runId: string;
	/** Human label: "historian[first]", "historian[repair]", "dreamer", etc. */
	label: string;
	/** Model string passed to the child, if known. */
	model?: string;
	/** Monotonic timestamp (Date.now()) when the run started. */
	startedAt: number;
	/** Monotonic timestamp when the run finished, if it has. */
	endedAt?: number;
	/** Final status: "running", "ok", "failed". */
	status: "running" | "ok" | "failed";
	/** Buffered progress events for this run, in order. */
	events: SubagentProgressEvent[];
}

type Listener = () => void;

class SubagentStreamBus {
	private runs = new Map<string, StreamEntry>();
	/** Ordered list of runIds for display (most recent first). */
	private runOrder: string[] = [];
	private listeners = new Set<Listener>();

	/**
	 * Start tracking a new subagent run. Called when the runner emits its
	 * first `spawned` event for a new pass.
	 */
	startRun(runId: string, label: string, model?: string): void {
		const entry: StreamEntry = {
			runId,
			label,
			model,
			startedAt: Date.now(),
			status: "running",
			events: [],
		};
		this.runs.set(runId, entry);
		this.runOrder = this.runOrder.filter((id) => id !== runId);
		this.runOrder.unshift(runId);
		// Cap retained runs to avoid unbounded memory on long sessions.
		if (this.runOrder.length > 20) {
			const dropped = this.runOrder.splice(20);
			for (const id of dropped) this.runs.delete(id);
		}
		this.notify();
	}

	/**
	 * Publish a progress event for an active run. If the runId is unknown,
	 * it's implicitly started with the runId as the label.
	 */
	publish(runId: string, label: string, event: SubagentProgressEvent): void {
		let entry = this.runs.get(runId);
		if (!entry) {
			this.startRun(runId, label);
			entry = this.runs.get(runId)!;
		}
		entry.events.push(event);

		// Update terminal status.
		if (event.type === "child_exit") {
			entry.endedAt = Date.now();
			entry.status = event.code === 0 ? "ok" : "failed";
		} else if (event.type === "terminal") {
			// Terminal event means the model produced output; child_exit
			// will set the final status. Don't mark as done yet.
		}
		this.notify();
	}

	/** Mark a run as finished (ok or failed) with an optional reason. */
	finishRun(runId: string, ok: boolean): void {
		const entry = this.runs.get(runId);
		if (!entry) return;
		entry.endedAt = Date.now();
		entry.status = ok ? "ok" : "failed";
		this.notify();
	}

	/** Get the most recent run entry, preferring a running run over finished ones. */
	getCurrentRun(): StreamEntry | null {
		if (this.runOrder.length === 0) return null;
		// Prefer the most recent RUNNING run so a skip/no-op that finishes
		// instantly doesn't shadow an active background recomp/historian.
		for (const id of this.runOrder) {
			const entry = this.runs.get(id);
			if (entry && entry.status === "running") return entry;
		}
		return this.runs.get(this.runOrder[0]!) ?? null;
	}

	/** Get a specific run by ID. */
	getRun(runId: string): StreamEntry | undefined {
		return this.runs.get(runId);
	}

	/** Get all runs, most recent first. */
	getAllRuns(): StreamEntry[] {
		return this.runOrder
			.map((id) => this.runs.get(id))
			.filter((e): e is StreamEntry => e !== undefined);
	}

	/** Subscribe to changes. Returns an unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const l of this.listeners) {
			try {
				l();
			} catch {
				// listener errors must not crash the bus
			}
		}
	}

	/** Remove a run from the bus entirely (for skips/no-ops with no events). */
	removeRun(runId: string): void {
		this.runs.delete(runId);
		this.runOrder = this.runOrder.filter((id) => id !== runId);
		this.notify();
	}

	/** Clear all runs (for testing). */
	clear(): void {
		this.runs.clear();
		this.runOrder = [];
		this.notify();
	}
}

/** Process-global singleton. */
let _bus: SubagentStreamBus | null = null;

export function getStreamBus(): SubagentStreamBus {
	if (!_bus) _bus = new SubagentStreamBus();
	return _bus;
}
