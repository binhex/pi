/**
 * Prompt Queue Extension — Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import promptQueueExtension from "./index";

// ── Test helpers ────────────────────────────────────────────────

interface EventMap {
	[k: string]: Array<(...args: unknown[]) => unknown>;
}

function createMockPI() {
	const handlers: EventMap = {};
	const commands = new Map<string, Function>();

	return {
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event]!.push(handler);
		}),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		registerCommand: vi.fn((name: string, opts: { handler: Function }) => {
			commands.set(name, opts.handler);
		}),
		registerShortcut: vi.fn(),
		// Test access
		_handlers: handlers,
		_commands: commands,
	};
}

function createMockCtx() {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: { fg: vi.fn(() => "") },
		},
	};
}

async function triggerEvent(
	pi: ReturnType<typeof createMockPI>,
	event: string,
	data: unknown,
): Promise<void> {
	const hs = pi._handlers[event];
	if (!hs) return;
	for (const h of hs) {
		await h(data, createMockCtx());
	}
}

function getCmdHandler(
	pi: ReturnType<typeof createMockPI>,
	name: string,
): ((args: string, ctx: unknown) => Promise<void>) | undefined {
	return pi._commands.get(name) as ((args: string, ctx: unknown) => Promise<void>) | undefined;
}

// ── Tests ───────────────────────────────────────────────────────

describe("prompt queue extension", () => {
	let pi: ReturnType<typeof createMockPI>;

	beforeEach(() => {
		vi.useFakeTimers();
		pi = createMockPI();
		promptQueueExtension(pi);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should not fire the auto-advance timer while the agent is busy", async () => {
		await triggerEvent(pi, "agent_start", { type: "agent_start" });

		const cmd = getCmdHandler(pi, "q");
		expect(cmd).toBeDefined();
		const ctx = createMockCtx();
		await cmd!("add test prompt", ctx);

		vi.advanceTimersByTime(6000);

		// Timer should NOT fire while agent is busy
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// Now agent finishes
		await triggerEvent(pi, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
		});

		vi.advanceTimersByTime(6000);

		// Timer should fire now that agent is idle
		expect(pi.sendUserMessage).toHaveBeenCalledWith("test prompt");
	});

	it("should start timer immediately when adding items while agent is idle", async () => {
		const cmd = getCmdHandler(pi, "q");
		expect(cmd).toBeDefined();
		const ctx = createMockCtx();

		await cmd!("add idle prompt", ctx);

		// Timer was started immediately; advance past delay
		vi.advanceTimersByTime(6000);

		expect(pi.sendUserMessage).toHaveBeenCalledWith("idle prompt");
	});

	it("should clear pending timer when agent starts processing", async () => {
		const cmd = getCmdHandler(pi, "q");
		expect(cmd).toBeDefined();
		const ctx = createMockCtx();

		// Add items while idle — timer starts
		await cmd!("add prompt one", ctx);

		// Agent starts before timer fires
		await triggerEvent(pi, "agent_start", { type: "agent_start" });

		// Advance past the original delay — timer was cancelled
		vi.advanceTimersByTime(6000);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// Agent finishes — timer should restart
		await triggerEvent(pi, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
		});

		vi.advanceTimersByTime(6000);

		// The /q command strips the first token ("add"), so the text is "prompt one"
		expect(pi.sendUserMessage).toHaveBeenCalledWith("prompt one");
	});

	it("should not start timer when resuming from pause while agent is busy", async () => {
		// Agent busy
		await triggerEvent(pi, "agent_start", { type: "agent_start" });

		// Add item — no timer (agent busy)
		const ctx = createMockCtx();

		// Simulate /q pause then /q resume
		const cmd = getCmdHandler(pi, "q");
		expect(cmd).toBeDefined();

		await cmd!("add paused prompt", ctx);
		await cmd!("pause", ctx);
		await cmd!("resume", ctx);

		vi.advanceTimersByTime(6000);

		// Timer should NOT fire — agent is still busy
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// Agent finishes
		await triggerEvent(pi, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
		});

		vi.advanceTimersByTime(6000);

		// Now the item should be sent
		expect(pi.sendUserMessage).toHaveBeenCalledWith("paused prompt");
	});

	it("should auto-advance through multiple queued items", async () => {
		const ctx = createMockCtx();
		const cmd = getCmdHandler(pi, "q");
		expect(cmd).toBeDefined();

		await cmd!("add first ;; second ;; third", ctx);

		// First agent_end (agent becomes idle)
		await triggerEvent(pi, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
		});

		vi.advanceTimersByTime(6000);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("first");

		// Second agent_end
		await triggerEvent(pi, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
		});

		vi.advanceTimersByTime(6000);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("second");

		// Third agent_end
		await triggerEvent(pi, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
		});

		vi.advanceTimersByTime(6000);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("third");
	});
});
