import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { build } from "esbuild"

import { createHandoff, listHandoffs, readHandoff, renderHandoffList, updateHandoff } from "../handoffs.js"
import { listPlans, readPlan } from "../plans.js"
import { makeTempDir } from "./fixtures.js"
import type { Session } from "../types.js"

const source: Session = {
	agent: "tumble-code",
	id: "019fb786-8ec1",
	title: "Migrate the checker | with a pipe",
	cwd: "/tmp/proj",
	gitBranch: "feat/checker",
	createdAt: Date.parse("2026-07-31T09:00:00.000Z"),
	updatedAt: Date.parse("2026-07-31T10:00:00.000Z"),
	path: "/tmp/tasks/019fb786-8ec1",
	messages: [
		{ role: "user", ts: 1, blocks: [{ type: "text", text: "Migrate the checker" }] },
		{
			role: "assistant",
			ts: 2,
			blocks: [{ type: "tool_use", name: "write_to_file", input: { path: "check.sh" } }],
		},
	],
}

describe("handoff lifecycle", () => {
	let dir: string

	beforeEach(() => {
		dir = makeTempDir("handoff")
		process.env.AGENT_INTERCHANGE_DIR = dir
	})

	afterEach(() => {
		delete process.env.AGENT_INTERCHANGE_DIR
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("writes a document that carries the briefing and the next steps", async () => {
		const handoff = await createHandoff({
			session: source,
			to: "claude-code",
			nextSteps: ["Run the integration suite", "Open the PR"],
			notes: "The staging box has an old bash.",
		})

		expect(fs.existsSync(handoff.path)).toBe(true)
		expect(handoff.path.startsWith(path.join(dir, "handoffs"))).toBe(true)
		expect(handoff.status).toBe("open")
		expect(handoff.body).toContain("## The request")
		expect(handoff.body).toContain("- [ ] Run the integration suite")
		expect(handoff.body).toContain("The staging box has an old bash.")
		expect(handoff.markdown.startsWith("---\n")).toBe(true)
	})

	it("round-trips frontmatter, including values that need quoting", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })
		const read = readHandoff(created.id)

		expect(read).toMatchObject({
			id: created.id,
			title: "Migrate the checker | with a pipe",
			from: "tumble-code",
			to: "claude-code",
			sourceSessionId: "019fb786-8ec1",
			cwd: "/tmp/proj",
			gitBranch: "feat/checker",
			status: "open",
		})
	})

	it("records the pick-up and appends to the log", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })

		const updated = await updateHandoff(created.id, {
			status: "picked-up",
			pickedUpBy: "claude-code",
			pickedUpSessionId: "sess-1",
			note: "picked up by Claude Code",
		})

		expect(updated).toMatchObject({ status: "picked-up", pickedUpBy: "claude-code", pickedUpSessionId: "sess-1" })
		expect(updated!.body).toContain("picked up by Claude Code")
		expect(updated!.updated >= created.updated).toBe(true)

		const done = await updateHandoff(created.id, { status: "done" })

		expect(done!.status).toBe("done")
		// Both log entries survive the rewrite.
		expect(done!.body).toContain("picked up by Claude Code")
		expect(done!.body).toContain("status → done")
	})

	it("filters listings by workspace, status and recipient", async () => {
		const mine = await createHandoff({ session: source, to: "claude-code" })
		await createHandoff({ session: { ...source, cwd: "/tmp/elsewhere" }, to: "claude-code" })

		expect(listHandoffs({ cwd: "/tmp/proj" }).map((entry) => entry.id)).toEqual([mine.id])
		expect(listHandoffs({ status: "open" })).toHaveLength(2)
		expect(listHandoffs({ status: "done" })).toHaveLength(0)
		expect(listHandoffs({ to: "tumble-code" })).toHaveLength(0)
	})

	it("renders a listing without breaking the table on a piped title", async () => {
		await createHandoff({ session: source, to: "claude-code" })

		const table = renderHandoffList(listHandoffs())

		expect(table).toContain("tumble-code → claude-code")
		expect(table).toContain("Migrate the checker \\| with a pipe")
	})

	it("refuses an id that is not a plain file name", async () => {
		expect(readHandoff("../../etc/passwd")).toBeUndefined()
		await expect(updateHandoff("nope", { status: "done" })).resolves.toBeUndefined()
	})

	it("returns nothing when no handoff has ever been written", () => {
		expect(listHandoffs()).toEqual([])
	})

	it("serializes competing updates so no status or log change is lost", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })

		await Promise.all([
			updateHandoff(created.id, { status: "picked-up", note: "first concurrent note" }),
			updateHandoff(created.id, { status: "done", note: "second concurrent note" }),
		])

		const final = readHandoff(created.id)!
		// Whichever revision sorts last decides the status; both log entries survive.
		expect(["picked-up", "done"]).toContain(final.status)
		expect(final.body).toContain("first concurrent note")
		expect(final.body).toContain("second concurrent note")
	})

	it("lets a later update move the status back, including out of done", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })

		await updateHandoff(created.id, { status: "done", note: "finished" })
		const reopened = await updateHandoff(created.id, { status: "open", note: "not actually finished" })
		expect(reopened!.status).toBe("open")

		const resumed = await updateHandoff(created.id, { status: "picked-up" })
		expect(resumed!.status).toBe("picked-up")
		expect(resumed!.body).toContain("finished")
		expect(resumed!.body).toContain("not actually finished")
	})

	it("folds the journal into the document instead of leaving the file stale", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })

		await updateHandoff(created.id, { status: "picked-up", pickedUpBy: "claude-code", note: "started" })

		const onDisk = fs.readFileSync(created.path, "utf8")
		expect(onDisk).toContain("status: picked-up")
		expect(onDisk).toContain("pickedUpBy: claude-code")
		expect(onDisk).toContain("started")
		// Folded operations are spent, so the journal does not grow without bound.
		expect(fs.readdirSync(`${created.path}.updates`).filter((name) => name.endsWith(".json"))).toEqual([])
		expect(readHandoff(created.id)!.status).toBe("picked-up")
	})

	it("ignores an operation that lands after a newer one was already folded", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })
		await updateHandoff(created.id, { status: "done", note: "finished first" })

		// A writer that stalled before its rename: published late, but older than
		// the revision the document already carries.
		const stale = {
			revision: "1999-01-01T000000000Z-00000000-0000-4000-8000-000000000000",
			created: "1999-01-01T00:00:00.000Z",
			status: "picked-up",
			note: "note from the stalled writer",
		}
		fs.writeFileSync(path.join(`${created.path}.updates`, `${stale.revision}.json`), JSON.stringify(stale), "utf8")

		const final = readHandoff(created.id)!
		expect(final.status).toBe("done")
		// Its log entry is still kept — the log is append-only, the status is not.
		expect(final.body).toContain("note from the stalled writer")
	})

	it("does not publish a revision for an update that carries nothing", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })

		const unchanged = await updateHandoff(created.id, {})

		expect(unchanged!.status).toBe("open")
		expect(fs.existsSync(`${created.path}.updates`)).toBe(false)
	})

	it("serializes updates made by independent Node processes", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })
		const worker = path.join(dir, "handoff-update-worker.mjs")
		const marker = path.join(dir, "first-writer-at-rename")

		await build({
			entryPoints: [path.join(import.meta.dirname, "fixtures", "handoff-update-worker.ts")],
			outfile: worker,
			bundle: true,
			format: "esm",
			platform: "node",
		})

		const first = runUpdateWorker(worker, {
			HANDOFF_ID: created.id,
			HANDOFF_STATUS: "picked-up",
			HANDOFF_NOTE: "first process note",
			HANDOFF_RENAME_MARKER: marker,
			HANDOFF_RENAME_DELAY_MS: "300",
		})
		await waitForFile(marker)
		const second = runUpdateWorker(worker, {
			HANDOFF_ID: created.id,
			HANDOFF_STATUS: "done",
			HANDOFF_NOTE: "second process note",
		})

		await Promise.all([first, second])

		const final = readHandoff(created.id)!
		expect(final.status).toBe("done")
		expect(final.body).toContain("first process note")
		expect(final.body).toContain("second process note")
	})

	it("does not let a crashed paused writer block or erase a later process update", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })
		const worker = path.join(dir, "handoff-crash-worker.mjs")
		const marker = path.join(dir, "paused-before-publish")
		await build({
			entryPoints: [path.join(import.meta.dirname, "fixtures", "handoff-update-worker.ts")],
			outfile: worker,
			bundle: true,
			format: "esm",
			platform: "node",
		})
		const paused = spawn(process.execPath, [worker], {
			env: {
				...process.env,
				HANDOFF_ID: created.id,
				HANDOFF_STATUS: "picked-up",
				HANDOFF_NOTE: "crashed process note",
				HANDOFF_RENAME_MARKER: marker,
				HANDOFF_RENAME_DELAY_MS: "30000",
			},
			stdio: ["ignore", "ignore", "pipe"],
		})
		await waitForFile(marker)
		paused.kill("SIGKILL")
		await waitForExit(paused)

		await runUpdateWorker(worker, {
			HANDOFF_ID: created.id,
			HANDOFF_STATUS: "done",
			HANDOFF_NOTE: "surviving process note",
		})

		const final = readHandoff(created.id)!
		expect(final.status).toBe("done")
		expect(final.body).toContain("surviving process note")
		expect(final.body).not.toContain("crashed process note")
		expect(fs.readdirSync(`${created.path}.updates`).some((name) => name.endsWith(".tmp"))).toBe(true)
	})

	it("keeps the previous complete file when atomic replacement fails", async () => {
		const created = await createHandoff({ session: source, to: "claude-code" })
		const before = fs.readFileSync(created.path, "utf8")

		await expect(
			updateHandoff(
				created.id,
				{ status: "done", note: "must not partially appear" },
				{ rename: async () => Promise.reject(new Error("simulated rename failure")) },
			),
		).rejects.toThrow("simulated rename failure")
		expect(fs.readFileSync(created.path, "utf8")).toBe(before)
		expect(fs.readdirSync(`${created.path}.updates`).filter((name) => name.endsWith(".tmp"))).toEqual([])
		expect(readHandoff(created.id)?.status).toBe("open")
	})
})

function runUpdateWorker(worker: string, environment: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [worker], {
			env: { ...process.env, ...environment },
			stdio: ["ignore", "ignore", "pipe"],
		})
		let stderr = ""
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk: string) => (stderr += chunk))
		child.once("error", reject)
		child.once("exit", (code, signal) => {
			if (code === 0) resolve()
			else reject(new Error(`Worker exited with ${code ?? signal}: ${stderr}`))
		})
	})
}

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 5_000
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`)
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject)
		child.once("exit", () => resolve())
	})
}

describe("plans", () => {
	let claudeDir: string
	let outside: string
	let workspace: string

	beforeEach(() => {
		claudeDir = makeTempDir("plans-cc")
		outside = makeTempDir("plans-outside")
		workspace = makeTempDir("plans-ws")
		process.env.CLAUDE_CONFIG_DIR = claudeDir

		fs.mkdirSync(path.join(claudeDir, "plans"), { recursive: true })
		fs.writeFileSync(path.join(claudeDir, "plans", "gleaming-fern.md"), "# Refactor the router\n\nbody", "utf8")

		fs.mkdirSync(path.join(workspace, "ai_plans"), { recursive: true })
		fs.writeFileSync(path.join(workspace, "ai_plans", "2026-07-31_thing.md"), "# The thing\n\nbody", "utf8")
		fs.writeFileSync(path.join(workspace, "secret.md"), "# not a plan", "utf8")
	})

	afterEach(() => {
		delete process.env.CLAUDE_CONFIG_DIR
		fs.rmSync(claudeDir, { recursive: true, force: true })
		fs.rmSync(outside, { recursive: true, force: true })
		fs.rmSync(workspace, { recursive: true, force: true })
	})

	it("lists privileged global and workspace plan documents, titled by their first heading", () => {
		const docs = listPlans({ cwd: workspace, allowClaudeGlobal: true })

		expect(docs.map((doc) => doc.title).sort()).toEqual(["Refactor the router", "The thing"])
		expect(docs.find((doc) => doc.title === "Refactor the router")!.source).toBe("claude-code")
		expect(docs.find((doc) => doc.title === "The thing")!.source).toBe("workspace")
	})

	it("reads a plan by the path the listing returned", () => {
		const doc = listPlans({ cwd: workspace }).find((entry) => entry.source === "workspace")!

		expect(readPlan(doc.path, { cwd: workspace })!.markdown).toContain("# The thing")
	})

	it("will not read a file outside the plan directories", () => {
		expect(readPlan(path.join(workspace, "secret.md"), { cwd: workspace })).toBeUndefined()
		expect(readPlan("/etc/passwd", { cwd: workspace })).toBeUndefined()
	})

	it.runIf(process.platform === "linux")("rejects a plan directory symlink that escapes the workspace", () => {
		fs.rmSync(path.join(workspace, "ai_plans"), { recursive: true })
		fs.writeFileSync(path.join(outside, "escaped.md"), "# Escaped directory plan\n\nsecret", "utf8")
		fs.symlinkSync(outside, path.join(workspace, "ai_plans"), "dir")

		expect(listPlans({ cwd: workspace }).map((doc) => doc.title)).not.toContain("Escaped directory plan")
		expect(readPlan(path.join(workspace, "ai_plans", "escaped.md"), { cwd: workspace })).toBeUndefined()
	})

	it.runIf(process.platform === "linux")("rejects a Markdown symlink that escapes a valid plan directory", () => {
		const outsidePlan = path.join(outside, "escaped.md")
		const linkedPlan = path.join(workspace, "ai_plans", "escaped.md")
		fs.writeFileSync(outsidePlan, "# Escaped file plan\n\nsecret", "utf8")
		fs.symlinkSync(outsidePlan, linkedPlan, "file")

		expect(listPlans({ cwd: workspace }).map((doc) => doc.title)).not.toContain("Escaped file plan")
		expect(readPlan(linkedPlan, { cwd: workspace })).toBeUndefined()
	})

	it.runIf(process.platform === "linux")(
		"keeps a Markdown symlink whose opened target remains inside its plan root",
		() => {
			const target = path.join(workspace, "ai_plans", "target.md")
			const linkedPlan = path.join(workspace, "ai_plans", "linked.md")
			fs.writeFileSync(target, "# Safe linked plan\n\nbody", "utf8")
			fs.symlinkSync(target, linkedPlan, "file")

			expect(listPlans({ cwd: workspace }).map((doc) => doc.title)).toContain("Safe linked plan")
			expect(readPlan(linkedPlan, { cwd: workspace })?.markdown).toContain("# Safe linked plan")
		},
	)
})
