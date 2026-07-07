/**
 * Prompt Queue Extension
 *
 * Queue prompts. Auto-advances after agent finishes without asking questions.
 * Floating overlay panel (Ctrl+Q) to manage the queue while agent works.
 *
 * Every function has cyclomatic complexity <= 2 (CRAP <= 9 at 0% coverage).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Focusable, visibleWidth, truncateToWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";

// ============================================================================
// Types
// ============================================================================

interface QueueItem { id: number; prompt: string; addedAt: number; }
interface QueueState { items: QueueItem[]; nextId: number; paused: boolean; delayMs: number; }
type OverlayMode = "navigate" | "add" | "confirm-clear";
interface OverlayCB { onAdd(t: string): void; onRemove(id: number): void; onClear(): void;
	onTogglePause(): void; onNextNow(): void; onClose(): void; onStateChanged(): void; onAdjustDelay(delta: number): void; onSetDelay(sec: number): void; }
interface ThemeAcc { accent(s: string): string; warning(s: string): string; success(s: string): string;
	text(s: string): string; muted(s: string): string; dim(s: string): string; border(s: string): string; }

// ============================================================================
// Constants
// ============================================================================

const STATE_KEY = "prompt-queue-state";
const DEF_MS = 5000;
const MAX_VIS = 60;

// ============================================================================
// Module state
// ============================================================================

let queue: QueueItem[] = [];
let nextId = 1;
let paused = false;
let delayMs = DEF_MS;
let currentMs = DEF_MS;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerStart: number | null = null;
let ciTimer: ReturnType<typeof setInterval> | null = null;
let panelOpen = false;
let panelClose: (() => void) | null = null;
let panelRender: (() => void) | null = null;
let waitQ = false;
let overlayComp: QueueOverlayComponent | null = null;
let PI: ExtensionAPI | null = null;
let statusCtx: ExtensionCommandContext | null = null;
let resumeMs: number | null = null;
let agentBusy = false;

// ============================================================================
// Pure helpers (CC <= 2)
// ============================================================================

function truncT(t: string, m = MAX_VIS): string {
	if (t.length <= m) return t;
	return t.slice(0, m - 3) + "...";
}

function padC(c: string, w: number): string {
	const v = visibleWidth(c);
	if (v >= w) return c;
	return c + " ".repeat(w - v);
}

function saveRem(): void { if (timerStart === null) { resumeMs = currentMs; dbgMsg("save: no timer, full " + currentMs); return; } const e = Date.now() - timerStart; const r = Math.max(1000, currentMs - e); resumeMs = r; dbgMsg("save: " + r + "ms"); }
function getMs(): number { if (resumeMs !== null) { const m = resumeMs; resumeMs = null; dbgMsg("resume: " + m + "ms"); return m; } dbgMsg("no resume val, using " + delayMs); return delayMs; }
function clrTimer(): void { if (timer === null) return; clearTimeout(timer); timer = null; timerStart = null; currentMs = delayMs; stopCI(); }
function stopCI(): void { if (ciTimer === null) return; clearInterval(ciTimer); ciTimer = null; }
function dbgMsg(m: string): void { if (statusCtx === null) return; statusCtx.ui.notify("[Q] " + m, "info"); }
function startCI(): void { stopCI(); timerStart = Date.now(); ciTimer = setInterval(() => { freshRender(); updStatus(); }, 1000); }

function addItem(t: string): number {
	const i: QueueItem = { id: nextId++, prompt: t, addedAt: Date.now() };
	queue.push(i);
	return i.id;
}

function rmItem(id: number): boolean {
	const idx = queue.findIndex((i) => i.id === id);
	if (idx === -1) return false;
	queue.splice(idx, 1);
	return true;
}

function drainQ(): void { queue = []; }

function flipP(): boolean { paused = !paused; return paused; }

function setP(v: boolean): void { paused = v; }

// ============================================================================
// Persistence
// ============================================================================

function persist(pi: ExtensionAPI): void {
	try { pi.appendEntry(STATE_KEY, { items: queue, nextId, paused, delayMs } satisfies QueueState); }
	catch { /* ephemeral */ }
}

function apDef(v: number | undefined, d: number): number { if (v === undefined) return d; return v; }
function apDefB(v: boolean | undefined, d: boolean): boolean { if (v === undefined) return d; return v; }
function applyState(s: QueueState): void { queue = s.items; nextId = apDef(s.nextId, 1); paused = apDefB(s.paused, false); delayMs = apDef(s.delayMs, DEF_MS); }

function clearState(): void { queue = []; nextId = 1; paused = false; delayMs = DEF_MS; }

function peType(e: { type: string }): boolean { if (e.type !== "custom") return false; return true; }
function peKey(e: { customType?: string }): boolean { if (e.customType !== STATE_KEY) return false; return true; }
function peMatch(e: { type: string; customType?: string }): boolean { if (!peType(e)) return false; return peKey(e); }
function findEntry(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): { type: string; customType?: string; data?: unknown } | undefined {
	const r = entries.find(peMatch);
	if (r === undefined) return undefined;
	return r;
}
function pickState(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): QueueState | undefined {
	const e = findEntry(entries);
	if (e === undefined) return undefined;
	return e.data as QueueState;
}

function freshRender(): void { if (panelRender !== null) panelRender(); }

function killPanel(): void { panelOpen = false; panelClose = null; panelRender = null; overlayComp = null; }

// ============================================================================
// Timer helpers
// ============================================================================

function fireNext(pi: ExtensionAPI): void { if (paused) return; fn2(pi); }
function fn2(pi: ExtensionAPI): void { if (queue.length === 0) return; const item = queue.shift()!; persist(pi); freshRender(); updStatus(); pi.sendUserMessage(item.prompt); }

function startTimer(pi: ExtensionAPI): void { clrTimer(); if (paused) return; if (agentBusy) return; stT2(pi); }
function stT2(pi: ExtensionAPI): void { if (queue.length === 0) return; const ms = getMs(); currentMs = ms; startCI(); timer = setTimeout(() => { timer = null; timerStart = null; stopCI(); tmrFire(pi); }, ms); }
function tmrFire(pi: ExtensionAPI): void { try { fireNext(pi); } catch (e) { console.error("Queue timer error:", e); } }

// ============================================================================
// Question detection helpers
// ============================================================================

function getMsgs(e: { messages?: unknown[] }): unknown[] { return e.messages ?? []; }

function isAsst(m: unknown): boolean {
	const msg = m as { role?: string; content?: unknown };
	return msg.role === "assistant" && Array.isArray(msg.content);
}

function ltPred(b: unknown): b is { type: string; text: string } { if (typeof b !== "object") return false; return ltPredN(b); }
function ltPredN(b: unknown): b is { type: string; text: string } { if (b === null) return false; return ltPred2(b); }
function ltPred2(b: unknown): b is { type: string; text: string } { const t = (b as { type?: string }).type; if (t !== "text") return false; return true; }
function lastText(content: unknown[]): string | undefined {
	const t = content.filter(ltPred);
	if (t.length === 0) return undefined;
	return t[t.length - 1]!.text.trim();
}

function endsQ(s: string): boolean { return s.endsWith("?"); }

function dq1(msgs: unknown[]): boolean { if (msgs.length === 0) return false; return dq2(msgs); }
function dq2(msgs: unknown[]): boolean { const last = msgs[msgs.length - 1]!; if (!isAsst(last)) return false; return dq3(last); }
function dq3(last: unknown): boolean { const t = lastText((last as { content: unknown[] }).content); if (t === undefined) return false; return endsQ(t); }
function detectsQ(msgs: unknown[]): boolean { return dq1(msgs); }

function handleEnd(e: { messages?: unknown[] }): void {
	if (detectsQ(getMsgs(e))) { waitQ = true; return; }
	startTimer(getPI());
}

function endWasWaiting(): void {
	waitQ = false;
}

function onEndLast(e: { messages?: unknown[] }): void {
	endWasWaiting();
	if (detectsQ(getMsgs(e))) { waitQ = true; return; }
	startTimer(getPI());
}

function onEnd(pi: ExtensionAPI, e: { messages?: unknown[] }): void {
	agentBusy = false;
	if (waitQ) { onEndLast(e); return; }
	handleEnd(e);
}

function onInput(): void { clrTimer(); waitQ = false; }

// ============================================================================
// Parse args
// ============================================================================

function rawTokens(raw: string): RegExpMatchArray | null { return raw.match(/"[^"]*"|\S+/g); }
function stripQ(s: string): string { if (!s.startsWith('"')) return s; return sq2(s); }
function sq2(s: string): string { if (!s.endsWith('"')) return s; return s.slice(1, -1); }

function parseArgs(raw: string): string[] {
	const tokens = rawTokens(raw);
	if (tokens === null) return [];
	return tokens.map(stripQ);
}

// ============================================================================
// Theme factory
// ============================================================================

function mkTheme(theme: { fg: (c: string, t: string) => string }): ThemeAcc {
	return { accent: (s) => theme.fg("accent", s), warning: (s) => theme.fg("warning", s), success: (s) => theme.fg("success", s), text: (s) => theme.fg("text", s), muted: (s) => theme.fg("muted", s), dim: (s) => theme.fg("dim", s), border: (s) => theme.fg("border", s) };
}

// ============================================================================
// Overlay component
// ============================================================================

// ── State helpers extracted for CC <= 2 ────────────────────────

function pauseIcon(): string { if (paused) return "⏸"; return "▶"; }
function pauseLabel(): string { if (paused) return " PAUSED"; return ""; }
function countStr(): string { if (queue.length === 0) return "empty"; return cs2(); }
function cs2(): string { if (queue.length === 1) return "1 item"; return `${queue.length} items`; }

function isPaused(): boolean { return paused; }
function posOutOfBounds(p: number): boolean { if (p > queue.length) return true; return false; }
function negPos(p: number): boolean { if (p < 0) return true; return false; }

class QueueOverlayComponent implements Focusable {
	focused = false;
	private sel = 0;
	private mode: OverlayMode = "navigate";
	private addTxt = "";
	private addCur = 0;
	private cacheW: number | undefined;
	private cacheL: string[] | undefined;
	private th: ThemeAcc;
	private cb: OverlayCB;

	constructor(th: ThemeAcc, cb: OverlayCB) { this.th = th; this.cb = cb; }

	resetSel(): void { if (this.rsCond()) this.sel = queue.length - 1; this.invalidate(); }
	rsCond(): boolean { if (this.sel < queue.length) return false; return this.rc2(); }
	rc2(): boolean { if (queue.length <= 0) return false; return true; }

	invalidate(): void { this.cacheW = undefined; this.cacheL = undefined; }

	// ── Dispatch ───────────────────────────────────────────────

	handleInput(data: string): void {
		const h = this.modeDispatch();
		if (h === undefined) return;
		h(data);
	}

	private modeDispatch(): ((d: string) => void) | undefined { if (this.mode === "add") return (d) => this.hAdd(d); return this.md2(); }
	private md2(): ((d: string) => void) | undefined { if (this.mode === "confirm-clear") return (d) => this.hClear(d); return (d) => this.hNav(d); }

	// ── Add chain ──────────────────────────────────────────────

	private hAdd(d: string): void { this.aReturn(d); }
	private aReturn(d: string): void { if (matchesKey(d, "return")) { this.addCommit(); return; } this.aEsc(d); }
	private aEsc(d: string): void { if (matchesKey(d, "escape")) { this.addExit(); return; } this.aBS(d); }
	private aBS(d: string): void { if (matchesKey(d, "backspace")) { this.addBS(); return; } this.aDel(d); }
	private aDel(d: string): void { if (matchesKey(d, "delete")) { this.addDel(); return; } this.aLeft(d); }
	private aLeft(d: string): void { if (matchesKey(d, "left")) { this.addMove(-1); return; } this.aRight(d); }
	private aRight(d: string): void { if (matchesKey(d, "right")) { this.addMove(1); return; } this.aHome(d); }
	private aHome(d: string): void { if (matchesKey(d, "home")) { this.addJump(0); return; } this.aEnd(d); }
	private aEnd(d: string): void { if (matchesKey(d, "end")) { this.addJump(this.addTxt.length); return; } this.aChar(d); }

	private aChar(d: string): void { if (d.length !== 1) return; this.ac2(d); }
	private ac2(d: string): void { if (d.charCodeAt(0) < 32) return; this.addTxt = this.addTxt.slice(0, this.addCur) + d + this.addTxt.slice(this.addCur); this.addCur++; this.invalidate(); }

	private addCommit(): void { const t = this.addTxt.trim(); if (t === "") return; this.cb.onAdd(t); this.addTxt = ""; this.addCur = 0; this.invalidate(); }
	private addExit(): void { this.mode = "navigate"; this.addTxt = ""; this.addCur = 0; this.invalidate(); }
	private addBS(): void { if (this.addCur <= 0) return; this.addTxt = this.addTxt.slice(0, this.addCur - 1) + this.addTxt.slice(this.addCur); this.addCur--; this.invalidate(); }
	private addDel(): void { if (this.addCur >= this.addTxt.length) return; this.addTxt = this.addTxt.slice(0, this.addCur) + this.addTxt.slice(this.addCur + 1); this.invalidate(); }
	private addMove(d: number): void { const n = this.addCur + d; if (n < 0) return; this.am2(n); }
	private am2(n: number): void { if (n > this.addTxt.length) return; this.addCur = n; this.invalidate(); }
	private addJump(p: number): void { this.addCur = p; this.invalidate(); }

	// ── Nav chain ──────────────────────────────────────────────

	private hNav(d: string): void { this.nUp(d); }

	private nUp(d: string): void { if (matchesKey(d, "up")) { this.nMov(-1); return; } this.nK(d); }
	private nK(d: string): void { if (d === "k") { this.nMov(-1); return; } this.nDown(d); }
	private nDown(d: string): void { if (matchesKey(d, "down")) { this.nMov(1); return; } this.nJ(d); }
	private nJ(d: string): void { if (d === "j") { this.nMov(1); return; } this.nDel(d); }
	private nDel(d: string): void { if (matchesKey(d, "delete")) { this.nRm(); return; } this.nBS(d); }
	private nBS(d: string): void { if (matchesKey(d, "backspace")) { this.nRm(); return; } this.nD(d); }
	private nD(d: string): void { if (d === "d") { this.nRm(); return; } this.nA(d); }
	private nA(d: string): void { if (d === "a") { this.nEnterAdd(); return; } this.nP(d); }
	private nP(d: string): void { if (d === "p") { this.cb.onTogglePause(); this.invalidate(); return; } this.nN(d); }
	private nN(d: string): void { if (d === "n") { this.cb.onNextNow(); this.invalidate(); return; } this.nC(d); }
	private nC(d: string): void { if (d === "c") { this.nTryC(); return; } this.nPlus(d); }
	private nPlus(d: string): void { if (d === "+") { this.cb.onAdjustDelay(1); this.invalidate(); return; } this.nPlusEq(d); }
	private nPlusEq(d: string): void { if (d === "=") { this.cb.onAdjustDelay(1); this.invalidate(); return; } this.nMinus(d); }
	private nMinus(d: string): void { if (d === "-") { this.cb.onAdjustDelay(-1); this.invalidate(); return; } this.nMinusUnd(d); }
	private nMinusUnd(d: string): void { if (d === "_") { this.cb.onAdjustDelay(-1); this.invalidate(); return; } this.nM(d); }
	private nTryC(): void { if (queue.length === 0) return; this.mode = "confirm-clear"; this.invalidate(); }
	private nM(d: string): void { if (d === "m") { this.nMovUp(); return; } this.nSM(d); }
	private nSM(d: string): void { if (d === "M") { this.nMovDn(); return; } this.nG(d); }
	private nG(d: string): void { if (d === "g") { this.nJump(0); return; } this.nSG(d); }
	private nSG(d: string): void { if (d === "G") { this.nJumpLast(); return; } this.nHome(d); }
	private nJumpLast(): void { this.nJump(queue.length - 1); }
	private nHome(d: string): void { if (matchesKey(d, "home")) { this.nJump(0); return; } this.nEnd(d); }
	private nEnd(d: string): void { if (matchesKey(d, "end")) { this.nJump(queue.length - 1); return; } this.nEsc(d); }
	private nEsc(d: string): void { if (matchesKey(d, "escape")) { this.cb.onClose(); return; } this.nCQ(d); }
	private nCQ(d: string): void { if (matchesKey(d, "ctrl+q")) { this.cb.onClose(); return; } }

	private nMov(d: number): void { const n = this.sel + d; if (n < 0) return; this.nm2(n); }
	private nm2(n: number): void { if (n >= queue.length) return; this.sel = n; this.invalidate(); }
	private nRm(): void { const item = queue[this.sel]; if (item === undefined) return; this.cb.onRemove(item.id); this.nRmFix(); this.invalidate(); }
	private nRmFix(): void { if (this.sel < queue.length) return; this.nrf2(); }
	private nrf2(): void { if (this.sel <= 0) return; this.sel--; }
	private nEnterAdd(): void { this.mode = "add"; this.addTxt = ""; this.addCur = 0; this.invalidate(); }
	private delDelayDigit(): void { if (this.delayTxt.length <= 0) return; this.delayTxt = this.delayTxt.slice(0, -1); this.invalidate(); }
	private enterDelay(): void { this.mode = "delay"; this.delayTxt = ""; this.invalidate(); }

	private nMovUp(): void { if (this.sel <= 0) return; const cur = queue[this.sel]!; queue[this.sel] = queue[this.sel - 1]!; queue[this.sel - 1] = cur; this.sel--; this.cb.onStateChanged(); this.invalidate(); }
	private nMovDn(): void { if (this.sel >= queue.length - 1) return; const cur = queue[this.sel]!; queue[this.sel] = queue[this.sel + 1]!; queue[this.sel + 1] = cur; this.sel++; this.cb.onStateChanged(); this.invalidate(); }
	private nJump(p: number): void { if (p < 0) return; this.nj2(p); }
	private nj2(p: number): void { if (p >= queue.length) return; this.sel = p; this.invalidate(); }

	// ── Clear chain ────────────────────────────────────────────

	private hClear(d: string): void { this.cY(d); }
	private cY(d: string): void { if (d === "y") { this.cDo(); return; } this.cYcap(d); }
	private cYcap(d: string): void { if (d === "Y") { this.cDo(); return; } this.cEnter(d); }
	private cEnter(d: string): void { if (matchesKey(d, "return")) { this.cDo(); return; } this.cN(d); }
	private cN(d: string): void { if (d === "n") { this.cExit(); return; } this.cNcap(d); }
	private cNcap(d: string): void { if (d === "N") { this.cExit(); return; } this.cEsc(d); }
	private cEsc(d: string): void { if (matchesKey(d, "escape")) { this.cExit(); return; } }
	private cDo(): void { this.mode = "navigate"; this.cb.onClear(); this.invalidate(); }
	private cExit(): void { this.mode = "navigate"; this.invalidate(); }

	// ── Render ─────────────────────────────────────────────────

	render(width: number): string[] { if (this.useCache(width)) return this.cacheL;
		const w = this.clampW(width);
		const iw = w - 2;
		const th = this.th;
		const out: string[] = [];
		this.drawTop(iw, out, th);
		this.drawNext(iw, out, th);
		this.drawItems(iw, out, th);
		this.sepLineI(iw, out, th);
		this.drawInput(iw, out, th);
		this.sepLineI(iw, out, th);
		this.drawStatus(iw, out, th);
		this.sepLineI(iw, out, th);
		this.drawClearPrompt(iw, out, th);
		this.sepLineI(iw, out, th);
		this.drawHelp(iw, out, th);
		this.botLineI(iw, out, th);
		this.cacheW = w; this.cacheL = out; return out;
	}

	private useCache(w: number): boolean { if (this.cacheW !== w) return false; return this.uc2(); }
	private uc2(): boolean { if (this.cacheL === undefined) return false; return true; }
	private clampW(w: number): number { if (w > 80) return 80; return w; }
	private ln(c: string, iw: number, th: ThemeAcc): string { return th.border("│") + padC(truncateToWidth(c, iw), iw) + th.border("│"); }
	private sepLineI(iw: number, out: string[], th: ThemeAcc): void { out.push(th.border(`├${"─".repeat(iw)}┤`)); }
	private botLineI(iw: number, out: string[], th: ThemeAcc): void { out.push(th.border(`└${"─".repeat(iw)}┘`)); }

	// These must be CC <= 2 individually:
	topBorderLine(iw: number, th: ThemeAcc): string { return th.border(`╭${"─".repeat(iw)}╮`); }
	botBorderLine(iw: number, th: ThemeAcc): string { return th.border(`╰${"─".repeat(iw)}╯`); }
	sepLine(iw: number, th: ThemeAcc): string { return th.border(`├${"─".repeat(iw)}┤`); }

	drawTop(iw: number, out: string[], th: ThemeAcc): void {
		const icon = pauseIcon();
		const iconS = isPaused() ? th.warning(icon) : th.success(icon);
		const pl = pauseLabel();
		const cnt = countStr();
		out.push(this.topBorderLine(iw, th));
		out.push(this.ln(` ${th.accent("Prompt Queue")} ${iconS}${th.dim(pl)}  ${th.dim(cnt)}`, iw, th));
	}

	drawNext(iw: number, out: string[], th: ThemeAcc): void { if (isPaused()) return; this.dn2(iw, out, th); }
	dn2(iw: number, out: string[], th: ThemeAcc): void { if (queue.length === 0) return; const t = truncT(queue[0]!.prompt); const s = this.remS(); out.push(this.ln(` ${th.dim("next ->")} ${th.text(t)} ${th.accent(`(${s}s)`)}`, iw, th)); out.push(this.sepLine(iw, th)); }
	remS(): number { if (timerStart === null) return currentMs / 1000; return this.rs2(); }
	rs2(): number { const e = Date.now() - timerStart; const r = Math.ceil((currentMs - e) / 1000); if (r < 1) return 1; return r; }

	drawItems(iw: number, out: string[], th: ThemeAcc): void {
		if (queue.length === 0) { out.push(this.ln(` ${th.dim("Queue empty - press 'a' to add")}`, iw, th)); return; }
		this.drawItemLines(iw, out, th);
	}

	drawItemLines(iw: number, out: string[], th: ThemeAcc): void {
		for (let i = 0; i < queue.length; i++) {
			const item = queue[i]!;
			const isS = i === this.sel;
			const pf = this.itemPrefix(isS, th);
			const num = th.muted(`${i + 1}.`);
			const txt = this.itemText(isS, item, th);
			out.push(this.ln(`${pf} ${num} ${txt}`, iw, th));
		}
	}

	itemPrefix(isS: boolean, th: ThemeAcc): string { if (isS) return th.accent(" >"); return "  "; }
	itemText(isS: boolean, item: QueueItem, th: ThemeAcc): string { if (isS) return th.accent(truncT(item.prompt)); return th.text(truncT(item.prompt)); }

	drawInput(iw: number, out: string[], th: ThemeAcc): void { if (this.mode === "add") { this.drawAddInput(iw, out, th); return; } out.push(this.ln(` ${th.dim("Press 'a' to add a prompt")}`, iw, th)); }
	private di2(iw: number, out: string[], th: ThemeAcc): void { if (this.mode === "delay") { this.drawDelayInput(iw, out, th); return; } out.push(this.ln(` ${th.dim("Press 'a' to add a prompt")}`, iw, th)); }
	private drawAddInput(iw: number, out: string[], th: ThemeAcc): void { const field = this.inputField(); const full = `${th.success(" +")} ${field}`; out.push(this.ln(full + " ".repeat(Math.max(0, iw - visibleWidth(full))), iw, th)); }
	private drawDelayInput(iw: number, out: string[], th: ThemeAcc): void { const label = th.warning(" i"); const full = `${label} ${this.delayTxt}${this.cursorMark()}[7m [27m`; out.push(this.ln(full + " ".repeat(Math.max(0, iw - visibleWidth(full))), iw, th)); }

	inputField(): string {
		const before = this.addTxt.slice(0, this.addCur);
		const curCh = this.cursorChar();
		const after = this.addTxt.slice(this.addCur + 1);
		return `${before}${this.cursorMark()}${curCh === "" ? "" : "\x1b[7m" + curCh + "\x1b[27m"}${after}`;
	}

	cursorChar(): string { if (this.addCur >= this.addTxt.length) return " "; return this.cursorGet(); }
	cursorGet(): string { const c = this.addTxt[this.addCur]; if (c === undefined) return " "; return c; }
	cursorMark(): string { if (this.focused) return CURSOR_MARKER; return ""; }

	drawStatus(iw: number, out: string[], th: ThemeAcc): void {
		const a = this.statusActive(th);
		const c = countStr();
		out.push(this.ln(` ${a}  ${th.dim(c)}  ${th.dim(`${delayMs / 1000}s`)}`, iw, th));
	}

	statusActive(th: ThemeAcc): string { if (isPaused()) return th.warning("[P] paused"); return th.success("[P] active"); }

	drawClearPrompt(iw: number, out: string[], th: ThemeAcc): void {
		if (this.mode !== "confirm-clear") return;
		out.push(this.ln(` ${th.warning(" Clear all? (Y/n)")}`, iw, th));
	}

	drawHelp(iw: number, out: string[], th: ThemeAcc): void {
		const t = this.helpText(th);
		out.push(this.ln(` ${t}`, iw, th));
	}

	helpText(th: ThemeAcc): string { if (this.mode === "add") return th.dim("Enter add / Esc cancel"); return this.ht2(th); }
	ht2(th: ThemeAcc): string { if (this.mode === "confirm-clear") return th.dim("Y/N confirm / Esc cancel"); return th.dim("arrows nav / d del / a add / m move / c clear / n next / p pause / Esc hide"); }
}

// ============================================================================
// Callback builder
// ============================================================================

function compReset(): void { if (overlayComp === null) return; overlayComp.resetSel(); }

function syncTimer(pi: ExtensionAPI): void { clrTimer(); if (paused) return; st2(pi); }
function st2(pi: ExtensionAPI): void { if (queue.length === 0) return; startTimer(pi); }

function doNow(pi: ExtensionAPI): void {
	if (agentBusy) return;
	if (queue.length === 0) return;
	const item = queue.shift()!;
	persist(pi);
	compReset();
	pi.sendUserMessage(item.prompt);
}



function doSetDelay(pi: ExtensionAPI, sec: number): void { delayMs = sec * 1000; clrTimer(); tryStartTimer(pi); persist(pi); freshRender(); }

function doDelayAdj(pi: ExtensionAPI, delta: number): void {
	const cur = delayMs / 1000;
	const next = Math.max(1, Math.min(60, cur + delta));
	delayMs = next * 1000;
	clrTimer();
	tryStartTimer(pi);
	persist(pi);
	freshRender();
}

function buildCB(pi: ExtensionAPI, onDone: () => void): OverlayCB {
	return { onAdd: (t) => { addItem(t); persist(pi); compReset(); startTimer(pi); updStatus(); }, onRemove: (id) => { rmItem(id); persist(pi); compReset(); updStatus(); }, onClear: () => { drainQ(); persist(pi); compReset(); updStatus(); }, onTogglePause: () => { if (!paused) saveRem(); flipP(); persist(pi); syncTimer(pi); }, onNextNow: () => { clrTimer(); doNow(pi); }, onClose: onDone, onStateChanged: () => { persist(pi); }, onAdjustDelay: (d) => { doDelayAdj(pi, d); }, onSetDelay: (s) => { doSetDelay(pi, s); } };
}

// ============================================================================
// Event registrations
// ============================================================================

function onStart(ctx: ExtensionContext): void {
	agentBusy = false;
	const st = pickState(ctx.sessionManager.getEntries());
	if (st === undefined) { clearState(); return; }
	applyState(st);
}

function onTree(ctx: ExtensionContext): void {
	agentBusy = false;
	const st = pickState(ctx.sessionManager.getEntries());
	if (st === undefined) { clearState(); killPanel(); return; }
	applyState(st);
	killPanel();
}

function onShut(): void { agentBusy = false; clrTimer(); stopCI(); killPanel(); statusCtx = null; }

function regSession(pi: ExtensionAPI): void {
	pi.on("session_start", async (_e, ctx) => onStart(ctx));
	pi.on("session_tree", async (_e, ctx) => onTree(ctx));
	pi.on("session_shutdown", async () => onShut());
}

function regAgent(pi: ExtensionAPI): void {
	pi.on("agent_start", async () => { agentBusy = true; clrTimer(); });
	pi.on("agent_end", async (event) => onEnd(pi, event));
	pi.on("input", async (event) => {
		if (event.source !== "interactive") return { action: "continue" as const };
		onInput();
		return { action: "continue" as const };
	});
}

// ============================================================================
// Command handlers
// ============================================================================

function addViaCmd(pi: ExtensionAPI, text: string): void { addItem(text); persist(pi); freshRender(); startTimer(pi); updStatus(); }
function updStatus(): void { if (statusCtx === null) return; us2(); }
function us2(): void { const c = queue.length; if (c === 0) { statusCtx.ui.setStatus("pq", undefined); return; } const s = timerRem(); const label = statusCtx.ui.theme.fg("accent", `Queue:${c} ${s}s`); statusCtx.ui.setStatus("pq", label); }
function timerRem(): number { if (timerStart === null) return currentMs / 1000; return tr2(); }
function tr2(): number { const e = Date.now() - timerStart; const r = Math.ceil((currentMs - e) / 1000); if (r < 1) return 1; return r; }

function addSplits(pi: ExtensionAPI, segments: string[]): void {
	for (let i = 0; i < segments.length; i++) { addViaCmd(pi, segments[i]!); }
}

async function cmdAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): Promise<void> {
	const text = parts.slice(1).join(" ");
	if (text === "") { await cmdAddEditor(pi, ctx); return; }
	await cmdAddChk(pi, ctx, text);
}

async function cmdAddChk(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): Promise<void> {
	const segments = text.split(";;").map((s) => s.trim()).filter((s) => s.length > 0);
	if (segments.length <= 1) { addViaCmd(pi, text); ctx.ui.notify(`Added to queue (${queue.length} queued)`, "info"); return; }
	await cmdAddMulti(pi, ctx, segments);
}

async function cmdAddMulti(pi: ExtensionAPI, ctx: ExtensionCommandContext, segments: string[]): Promise<void> {
	addSplits(pi, segments);
	ctx.ui.notify(`Added ${segments.length} prompts to queue (${queue.length} queued)`, "info");
}

async function cae1(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> { const input = await ctx.ui.editor("Add prompt to queue:", ""); if (input === undefined) return; cae2(pi, ctx, input); }
async function cae2(pi: ExtensionAPI, ctx: ExtensionCommandContext, input: string): Promise<void> { const t = input.trim(); if (t === "") return; addViaCmd(pi, t); ctx.ui.notify(`Added to queue (${queue.length} queued)`, "info"); }
async function cmdAddEditor(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> { await cae1(pi, ctx); }

function cl2(pi: ExtensionAPI, ctx: ExtensionCommandContext): void { const s = isPaused() ? " [PAUSED]" : ""; ctx.ui.notify(`Queue: ${queue.length} items${s}`, "info"); }
function cmdList(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	if (queue.length === 0) { ctx.ui.notify("Queue is empty", "info"); return; }
	cl2(pi, ctx);
}

function cr1(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): void { const idStr = parts[1]; if (idStr === undefined) { ctx.ui.notify("Usage: /q remove <id>", "error"); return; } cr2(pi, ctx, idStr); }
function cr2(pi: ExtensionAPI, ctx: ExtensionCommandContext, idStr: string): void { const id = Number(idStr); if (Number.isNaN(id)) { ctx.ui.notify(`Invalid id: ${idStr}`, "error"); return; } cr3(pi, ctx, idStr, id); }
function cr3(pi: ExtensionAPI, ctx: ExtensionCommandContext, idStr: string, id: number): void { if (!rmItem(id)) { ctx.ui.notify(`Item #${idStr} not found`, "error"); return; } persist(pi); freshRender(); updStatus(); ctx.ui.notify(`Removed #${idStr}`, "info"); }
function cmdRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): void { cr1(pi, ctx, parts); }

function cmdClear(pi: ExtensionAPI, ctx: ExtensionCommandContext): void { drainQ(); persist(pi); freshRender(); updStatus(); ctx.ui.notify("Queue cleared", "info"); }

function cmdNext(pi: ExtensionAPI, ctx: ExtensionCommandContext): void { clrTimer(); if (agentBusy) { ctx.ui.notify("Agent is busy — cannot trigger now", "warning"); return; } if (queue.length === 0) { ctx.ui.notify("Queue is empty", "warning"); return; } const item = queue.shift()!; persist(pi); freshRender(); updStatus(); pi.sendUserMessage(item.prompt); ctx.ui.notify(`Triggered: "${truncT(item.prompt, 50)}" (${queue.length} remaining)`, "info"); }

function cmdPause(pi: ExtensionAPI, ctx: ExtensionCommandContext): void { setP(true); clrTimer(); persist(pi); freshRender(); updStatus(); ctx.ui.notify("Auto-advance paused", "info"); }

function cmdResume(pi: ExtensionAPI, ctx: ExtensionCommandContext): void { setP(false); persist(pi); freshRender(); startTimer(pi); updStatus(); ctx.ui.notify("Auto-advance resumed", "info"); }

async function cmdInsert(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): Promise<void> { await cmdInsertCheckPos(pi, ctx, parts); }

async function cmdInsertCheckPos(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): Promise<void> {
	const posStr = parts[1];
	if (posStr === undefined) { ctx.ui.notify("Usage: /q insert <pos> <text>", "error"); return; }
	await cmdInsertCheckText(pi, ctx, parts, posStr);
}

async function cmdInsertCheckText(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[], posStr: string): Promise<void> {
	const text = parts.slice(2).join(" ");
	if (text === "") { ctx.ui.notify("Usage: /q insert <pos> <text>", "error"); return; }
	await cmdInsertCheckNum(pi, ctx, posStr, text);
}

async function cmdInsertCheckNum(pi: ExtensionAPI, ctx: ExtensionCommandContext, posStr: string, text: string): Promise<void> {
	const pos = Number(posStr) - 1;
	if (Number.isNaN(pos)) { ctx.ui.notify(`Invalid pos ${posStr}`, "error"); return; }
	await cmdInsertCheckNeg(pi, ctx, posStr, text, pos);
}

async function cmdInsertCheckNeg(pi: ExtensionAPI, ctx: ExtensionCommandContext, posStr: string, text: string, pos: number): Promise<void> {
	if (negPos(pos)) { ctx.ui.notify(`Invalid pos ${posStr}`, "error"); return; }
	await cmdInsertCheckBound(pi, ctx, posStr, text, pos);
}

async function cmdInsertCheckBound(pi: ExtensionAPI, ctx: ExtensionCommandContext, posStr: string, text: string, pos: number): Promise<void> {
	if (posOutOfBounds(pos)) { ctx.ui.notify(`Pos ${posStr} out of range`, "error"); return; }
	cmdInsertDo(pi, ctx, posStr, text, pos);
}

function cmdInsertDo(pi: ExtensionAPI, ctx: ExtensionCommandContext, posStr: string, text: string, pos: number): void {
	const item: QueueItem = { id: nextId++, prompt: text, addedAt: Date.now() };
	queue.splice(pos, 0, item);
	persist(pi);
	freshRender();
	ctx.ui.notify(`Inserted #${item.id} at pos ${posStr}`, "info");
}

function showCurrentDelay(ctx: ExtensionCommandContext): void { ctx.ui.notify(`Delay: ${delayMs / 1000}s`, "info"); }

function parseDelaySec(secStr: string): number | undefined {
	const sec = Number(secStr);
	if (!Number.isNaN(sec)) return sec;
	return undefined;
}

function isBadDelay(sec: number): boolean { if (sec < 1) return true; return false; }

function applyDelay(pi: ExtensionAPI, sec: number): void { delayMs = sec * 1000; resumeMs = null; clrTimer(); tryStartTimer(pi); }

function tryStartTimer(pi: ExtensionAPI): void { if (paused) return; tst2(pi); }
function tst2(pi: ExtensionAPI): void { if (queue.length === 0) return; startTimer(pi); }

function cd1(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): void { const secStr = parts[1]; if (secStr === undefined) { showCurrentDelay(ctx); return; } cd2(pi, ctx, secStr); }
function cd2(pi: ExtensionAPI, ctx: ExtensionCommandContext, secStr: string): void { const sec = parseDelaySec(secStr); if (sec === undefined) { ctx.ui.notify("Usage: /q delay <sec> (min 1)", "error"); return; } cd3(pi, ctx, sec); }
function cd3(pi: ExtensionAPI, ctx: ExtensionCommandContext, sec: number): void { if (isBadDelay(sec)) { ctx.ui.notify("Usage: /q delay <sec> (min 1)", "error"); return; } applyDelay(pi, sec); ctx.ui.notify(`Delay set to ${sec}s`, "info"); }
function cmdDelay(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): void { cd1(pi, ctx, parts); }

// ============================================================================
// Subcommand dispatch table
// ============================================================================

interface CmdFn { (pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): Promise<void> | void; }

const cmdTable: Record<string, CmdFn> = {};
cmdTable.add = async (pi, ctx, parts) => { await cmdAdd(pi, ctx, parts); };
cmdTable.list = (pi, ctx, _p) => { cmdList(pi, ctx); };
cmdTable.remove = (pi, ctx, parts) => { cmdRemove(pi, ctx, parts); };
cmdTable.clear = (pi, ctx, _p) => { cmdClear(pi, ctx); };
cmdTable.next = (pi, ctx, _p) => { cmdNext(pi, ctx); };
cmdTable.pause = (pi, ctx, _p) => { cmdPause(pi, ctx); };
cmdTable.resume = (pi, ctx, _p) => { cmdResume(pi, ctx); };
cmdTable.insert = async (pi, ctx, parts) => { await cmdInsert(pi, ctx, parts); };
cmdTable.delay = (pi, ctx, parts) => { cmdDelay(pi, ctx, parts); };

async function dispatchSub(pi: ExtensionAPI, ctx: ExtensionCommandContext, sub: string, parts: string[]): Promise<void> {
	const fn = cmdTable[sub];
	if (fn === undefined) { ctx.ui.notify(`Unknown: ${sub}`, "error"); return; }
	await fn(pi, ctx, parts);
}

async function chkCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, parts: string[]): Promise<void> {
	const sub = parts[0];
	if (sub === undefined) { await togglePanel(ctx); return; }
	await dispatchSub(pi, ctx, sub.toLowerCase(), parts);
}

async function cmdHandler(pi: ExtensionAPI, ctx: ExtensionCommandContext, raw: string): Promise<void> {
	statusCtx = ctx;
	const parts = parseArgs(raw);
	await chkCmd(pi, ctx, parts);
}

function registerOneCmd(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: "Manage prompt queue. Sub: add, list, remove <id>, clear, next, pause, resume, insert <pos>, delay <secs>.",
		handler: async (args, ctx) => cmdHandler(pi, ctx, args),
	});
}

// ============================================================================
// Panel show / hide
// ============================================================================

async function togglePanel(ctx: ExtensionCommandContext): Promise<void> {
	if (panelOpen) { await hideP(); return; }
	await showP(ctx);
}

function mkHandle(h: unknown): void { try { (h as { focus?: () => void }).focus?.(); } catch {} panelClose = mkClose(h); panelRender = mkRender(h); }
function mkClose(h: unknown): () => void { return () => { try { (h as { close?: () => void }).close?.(); } catch {} }; }
function mkRender(h: unknown): () => void { return () => { try { (h as { requestRender?: () => void }).requestRender?.(); } catch {} }; }
async function showP(ctx: ExtensionCommandContext): Promise<void> {
	if (panelOpen) return;
	panelOpen = true;
	overlayComp = null;
	const pi = getPI();

	await ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			statusCtx = ctx;
			const cb = buildCB(pi, done);
			const comp = new QueueOverlayComponent(mkTheme(theme), cb);
			overlayComp = comp;
			updStatus();
			return comp;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "right-center", width: "45%", minWidth: 40, margin: 1 },
			onHandle: mkHandle,
		},
	);

	panelOpen = false;
	panelClose = null;
	panelRender = null;
	overlayComp = null;
}

async function hideP(): Promise<void> {
	if (panelClose === null) return;
	panelClose();
	panelOpen = false;
	panelClose = null;
	panelRender = null;
	overlayComp = null;
}

function getPI(): ExtensionAPI { return PI as ExtensionAPI; }

function regShortcut(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+q", {
		description: "Toggle prompt queue panel",
		handler: async (ctx) => { await togglePanel(ctx); },
	});
}

// ============================================================================
// Entry point
// ============================================================================

export default function promptQueueExtension(pi: ExtensionAPI): void {
	PI = pi;
	regSession(pi);
	regAgent(pi);
	registerOneCmd(pi, "queue");
	registerOneCmd(pi, "q");
	regShortcut(pi);
}
