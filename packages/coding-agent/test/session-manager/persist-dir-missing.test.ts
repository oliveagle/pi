import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Regression tests for session-dir recovery.
 *
 * Root cause: SessionManager.mkdirSync runs only at construction. If the
 * session directory is removed externally between construction and the next
 * write (e.g. `git clean -fd` against an unignored path, manual `rm -rf`,
 * disk-cleanup scripts), openSync/writeFileSync/appendFileSync throw ENOENT
 * and the session silently fails to persist.
 *
 * Fix: SessionManager._ensureSessionDir() recreates the parent directory
 * on demand before every write.
 *
 * These tests cover the three write sites:
 *   - _persist first flush via openSync(..., "wx")
 *   - _persist appendFileSync after the first flush
 *   - _rewriteFile (used by createBranchedSession and migrate)
 */
describe("SessionManager persist with missing session directory", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-dir-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function assistantMessage(timestamp: number) {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp,
		};
	}

	it("recreates the session dir if it disappears before the first flush", () => {
		const session = SessionManager.create(tempDir, sessionDir);
		expect(session.getSessionFile()).toBeDefined();

		// Simulate external cleanup: the whole sessions dir is gone.
		rmSync(sessionDir, { recursive: true, force: true });

		// First user message — stays in memory because there is no assistant yet.
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		expect(session.getSessionFile()).toBeDefined();

		// First assistant message triggers the exclusive-create openSync("wx").
		// Before the fix this threw ENOENT and bubbled up to the UI.
		expect(() => session.appendMessage(assistantMessage(2))).not.toThrow();

		// File exists and contains both messages.
		const file = session.getSessionFile()!;
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3); // header + user + assistant
		expect(JSON.parse(lines[1]).message.role).toBe("user");
		expect(JSON.parse(lines[2]).message.role).toBe("assistant");
	});

	it("recreates the session dir if it disappears between flushes", () => {
		const session = SessionManager.create(tempDir, sessionDir);

		// Land the first flush so the file actually exists on disk.
		session.appendMessage({ role: "user", content: "u1", timestamp: 1 });
		session.appendMessage(assistantMessage(2));
		const file = session.getSessionFile()!;
		expect(readFileSync(file, "utf8")).toContain("u1");

		// External cleanup after first flush. _persist uses appendFileSync after
		// flushed === true, so the new entry is the only thing written — the
		// pre-existing file contents are gone. The point of this test is only
		// that the write path no longer throws ENOENT.
		rmSync(sessionDir, { recursive: true, force: true });

		expect(() => session.appendMessage(assistantMessage(3))).not.toThrow();

		// The newly appended assistant entry is on disk; the file is well-formed JSONL.
		const written = readFileSync(file, "utf8").trim().split("\n");
		expect(written.length).toBeGreaterThanOrEqual(1);
		const last = JSON.parse(written[written.length - 1]);
		expect(last.type).toBe("message");
		expect(last.message.role).toBe("assistant");
		expect(last.message.timestamp).toBe(3);
	});

	it("recreates the session dir before _rewriteFile (createBranchedSession)", () => {
		const session = SessionManager.create(tempDir, sessionDir);

		// Build a branch that has an assistant message so createBranchedSession
		// takes the _rewriteFile path.
		const userId = session.appendMessage({ role: "user", content: "u", timestamp: 1 });
		const assistantId = session.appendMessage(assistantMessage(2));

		// External cleanup right before branching.
		rmSync(sessionDir, { recursive: true, force: true });

		const branchedPath = session.createBranchedSession(assistantId);
		expect(branchedPath).toBeDefined();
		expect(() => readFileSync(branchedPath!, "utf8")).not.toThrow();

		const lines = readFileSync(branchedPath!, "utf8").trim().split("\n");
		// header + user + assistant
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(JSON.parse(lines[1]).message.role).toBe("user");
		expect(JSON.parse(lines[2]).message.role).toBe("assistant");

		// Defensive: original userId was in the branched path too.
		const ids = lines.map((l) => JSON.parse(l).id);
		expect(ids).toContain(userId);
		expect(ids).toContain(assistantId);
	});

	it("does not recreate the dir when nothing needs to be persisted (inMemory)", () => {
		const session = SessionManager.inMemory(tempDir);
		expect(() => session.appendMessage({ role: "user", content: "hi", timestamp: 1 })).not.toThrow();
		expect(session.getSessionFile()).toBeUndefined();
	});
});
