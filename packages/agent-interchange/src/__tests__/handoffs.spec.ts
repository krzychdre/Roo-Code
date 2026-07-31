import * as fs from "node:fs"
import * as path from "node:path"

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

	it("writes a document that carries the briefing and the next steps", () => {
		const handoff = createHandoff({
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

	it("round-trips frontmatter, including values that need quoting", () => {
		const created = createHandoff({ session: source, to: "claude-code" })
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

	it("records the pick-up and appends to the log", () => {
		const created = createHandoff({ session: source, to: "claude-code" })

		const updated = updateHandoff(created.id, {
			status: "picked-up",
			pickedUpBy: "claude-code",
			pickedUpSessionId: "sess-1",
			note: "picked up by Claude Code",
		})

		expect(updated).toMatchObject({ status: "picked-up", pickedUpBy: "claude-code", pickedUpSessionId: "sess-1" })
		expect(updated!.body).toContain("picked up by Claude Code")
		expect(updated!.updated >= created.updated).toBe(true)

		const done = updateHandoff(created.id, { status: "done" })

		expect(done!.status).toBe("done")
		// Both log entries survive the rewrite.
		expect(done!.body).toContain("picked up by Claude Code")
		expect(done!.body).toContain("status → done")
	})

	it("filters listings by workspace, status and recipient", () => {
		const mine = createHandoff({ session: source, to: "claude-code" })
		createHandoff({ session: { ...source, cwd: "/tmp/elsewhere" }, to: "claude-code" })

		expect(listHandoffs({ cwd: "/tmp/proj" }).map((entry) => entry.id)).toEqual([mine.id])
		expect(listHandoffs({ status: "open" })).toHaveLength(2)
		expect(listHandoffs({ status: "done" })).toHaveLength(0)
		expect(listHandoffs({ to: "tumble-code" })).toHaveLength(0)
	})

	it("renders a listing without breaking the table on a piped title", () => {
		createHandoff({ session: source, to: "claude-code" })

		const table = renderHandoffList(listHandoffs())

		expect(table).toContain("tumble-code → claude-code")
		expect(table).toContain("Migrate the checker \\| with a pipe")
	})

	it("refuses an id that is not a plain file name", () => {
		expect(readHandoff("../../etc/passwd")).toBeUndefined()
		expect(updateHandoff("nope", { status: "done" })).toBeUndefined()
	})

	it("returns nothing when no handoff has ever been written", () => {
		expect(listHandoffs()).toEqual([])
	})
})

describe("plans", () => {
	let claudeDir: string
	let workspace: string

	beforeEach(() => {
		claudeDir = makeTempDir("plans-cc")
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
		fs.rmSync(workspace, { recursive: true, force: true })
	})

	it("lists both agents' plan documents, titled by their first heading", () => {
		const docs = listPlans({ cwd: workspace })

		expect(docs.map((doc) => doc.title).sort()).toEqual(["Refactor the router", "The thing"])
		expect(docs.find((doc) => doc.title === "Refactor the router")!.source).toBe("claude-code")
		expect(docs.find((doc) => doc.title === "The thing")!.source).toBe("workspace")
	})

	it("reads a plan by the path the listing returned", () => {
		const doc = listPlans({ cwd: workspace }).find((entry) => entry.source === "workspace")!

		expect(readPlan(doc.path, workspace)!.markdown).toContain("# The thing")
	})

	it("will not read a file outside the plan directories", () => {
		expect(readPlan(path.join(workspace, "secret.md"), workspace)).toBeUndefined()
		expect(readPlan("/etc/passwd", workspace)).toBeUndefined()
	})
})
