import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import {
	ArtifactStore,
	MAX_ARTIFACT_BYTES,
	artifactCandidatePaths,
	artifactDirForKind,
	artifactFileName,
	artifactKindFromId,
	isValidArtifactId,
} from "../ArtifactStore"

describe("ArtifactStore", () => {
	let taskDir: string

	beforeEach(() => {
		taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-store-"))
	})

	afterEach(() => {
		fs.rmSync(taskDir, { recursive: true, force: true })
	})

	describe("id format", () => {
		it("keeps the historical cmd artifact naming", () => {
			expect(artifactFileName("cmd", "1706119234567")).toBe("cmd-1706119234567.txt")
			expect(artifactFileName("tool", 1706119234567)).toBe("tool-1706119234567.txt")
		})

		it("accepts every known kind and rejects path traversal", () => {
			expect(isValidArtifactId("cmd-1706119234567.txt")).toBe(true)
			expect(isValidArtifactId("tool-1706119234567.txt")).toBe(true)
			expect(isValidArtifactId("prune-1.txt")).toBe(true)
			expect(isValidArtifactId("fetch-1.txt")).toBe(true)

			expect(isValidArtifactId("../../../etc/passwd")).toBe(false)
			expect(isValidArtifactId("cmd-123/../other.txt")).toBe(false)
			expect(isValidArtifactId("cmd-.txt")).toBe(false)
			expect(isValidArtifactId("other-1.txt")).toBe(false)
			expect(isValidArtifactId("tool-1.log")).toBe(false)
		})

		it("reports the kind encoded in an id", () => {
			expect(artifactKindFromId("tool-1.txt")).toBe("tool")
			expect(artifactKindFromId("cmd-1.txt")).toBe("cmd")
			expect(artifactKindFromId("nope")).toBeUndefined()
		})
	})

	describe("directories", () => {
		it("keeps cmd artifacts in command-output and everything else in artifacts", () => {
			expect(artifactDirForKind(taskDir, "cmd")).toBe(path.join(taskDir, "command-output"))
			expect(artifactDirForKind(taskDir, "tool")).toBe(path.join(taskDir, "artifacts"))
			expect(artifactDirForKind(taskDir, "prune")).toBe(path.join(taskDir, "artifacts"))
			expect(artifactDirForKind(taskDir, "fetch")).toBe(path.join(taskDir, "artifacts"))
		})

		it("probes the kind's directory first and the other one as a fallback", () => {
			expect(artifactCandidatePaths(taskDir, "cmd-1.txt")).toEqual([
				path.join(taskDir, "command-output", "cmd-1.txt"),
				path.join(taskDir, "artifacts", "cmd-1.txt"),
			])
			expect(artifactCandidatePaths(taskDir, "tool-1.txt")).toEqual([
				path.join(taskDir, "artifacts", "tool-1.txt"),
				path.join(taskDir, "command-output", "tool-1.txt"),
			])
		})
	})

	describe("save", () => {
		it("writes the full text and returns id, size and path", () => {
			const store = new ArtifactStore(taskDir)
			const text = "line one\nline two\n"

			const saved = store.save("tool", text, 1706119234567)

			expect(saved.id).toBe("tool-1706119234567.txt")
			expect(saved.bytes).toBe(Buffer.byteLength(text, "utf8"))
			expect(saved.path).toBe(path.join(taskDir, "artifacts", "tool-1706119234567.txt"))
			expect(fs.readFileSync(saved.path, "utf8")).toBe(text)
		})

		it("creates the artifact directory when it does not exist", () => {
			const store = new ArtifactStore(taskDir)
			expect(fs.existsSync(path.join(taskDir, "artifacts"))).toBe(false)

			store.save("tool", "x", 1)

			expect(fs.existsSync(path.join(taskDir, "artifacts"))).toBe(true)
		})

		it("never overwrites when two artifacts land in the same millisecond", () => {
			const store = new ArtifactStore(taskDir)

			const first = store.save("tool", "first", 1706119234567)
			const second = store.save("tool", "second", 1706119234567)
			const third = store.save("tool", "third", 1706119234567)

			expect(first.id).toBe("tool-1706119234567.txt")
			expect(second.id).toBe("tool-1706119234568.txt")
			expect(third.id).toBe("tool-1706119234569.txt")
			expect(fs.readFileSync(first.path, "utf8")).toBe("first")
			expect(fs.readFileSync(second.path, "utf8")).toBe("second")
			expect(fs.readFileSync(third.path, "utf8")).toBe("third")
		})

		it("caps a pathological payload and says what was dropped", () => {
			const store = new ArtifactStore(taskDir)
			const oversized = "q".repeat(MAX_ARTIFACT_BYTES + 500_000)

			const saved = store.save("tool", oversized, 1)
			const written = fs.readFileSync(saved.path, "utf8")

			expect(saved.bytes).toBeLessThan(Buffer.byteLength(oversized, "utf8"))
			expect(saved.bytes).toBe(Buffer.byteLength(written, "utf8"))
			expect(written.startsWith("q".repeat(1000))).toBe(true)
			expect(written).toContain("[Artifact truncated at 10 MB;")
			expect(written).toContain("500000 bytes of the original output were dropped")
		})

		it("counts bytes, not characters", () => {
			const store = new ArtifactStore(taskDir)
			const saved = store.save("tool", "zażółć", 1)
			expect(saved.bytes).toBe(Buffer.byteLength("zażółć", "utf8"))
		})
	})

	describe("cleanup", () => {
		it("removes only artifacts of the requested kinds", async () => {
			const store = new ArtifactStore(taskDir)
			store.save("tool", "a", 1)
			store.save("prune", "b", 2)
			const artifactsDir = path.join(taskDir, "artifacts")
			fs.writeFileSync(path.join(artifactsDir, "keep-me.json"), "{}")

			await ArtifactStore.cleanup(artifactsDir, ["tool"])

			expect(fs.readdirSync(artifactsDir).sort()).toEqual(["keep-me.json", "prune-2.txt"])
		})

		it("keeps artifacts whose timestamp is still referenced", async () => {
			const commandOutputDir = path.join(taskDir, "command-output")
			fs.mkdirSync(commandOutputDir, { recursive: true })
			fs.writeFileSync(path.join(commandOutputDir, "cmd-111.txt"), "keep")
			fs.writeFileSync(path.join(commandOutputDir, "cmd-222.txt"), "drop")

			await ArtifactStore.cleanupByIds(commandOutputDir, new Set(["111"]), "cmd")

			expect(fs.readdirSync(commandOutputDir)).toEqual(["cmd-111.txt"])
		})

		it("is a no-op for a directory that does not exist", async () => {
			await expect(ArtifactStore.cleanup(path.join(taskDir, "nope"))).resolves.toBeUndefined()
			await expect(ArtifactStore.cleanupByIds(path.join(taskDir, "nope"), new Set())).resolves.toBeUndefined()
		})
	})
})
