import * as vscode from "vscode"

import {
	AGENT_LABELS,
	createHandoff,
	listClaudeSessions,
	listHandoffs,
	readClaudeSession,
	readTumbleSession,
	renderBriefing,
	updateHandoff,
	type Handoff,
	type SessionSummary,
} from "@roo-code/agent-interchange"

import { ClineProvider } from "../webview/ClineProvider"
import { getStorageBasePath } from "../../utils/storage"
import { t } from "../../i18n"

/**
 * Picking work up from Claude Code, and handing work back to it.
 *
 * The interchange itself lives in `@roo-code/agent-interchange` and is also
 * reachable over MCP; these two commands exist because only extension code can
 * start a Tumble task, and because a person switching tools wants a list to
 * click, not a tool call to compose.
 *
 * A pick-up seeds a *new* task with the briefing rather than resurrecting the
 * foreign session: tool names, signed reasoning blocks and tool-call pairing do
 * not survive translation between the two agents, so a fabricated session would
 * be subtly broken in ways a briefing is not.
 */

/**
 * `kind` is taken by `vscode.QuickPickItem` (separator vs. item), so the
 * interchange's own discriminator has to be named differently — intersecting
 * the two would collapse the property to `never`.
 */
type PickItem = vscode.QuickPickItem & {
	source: "handoff" | "session"
	handoff?: Handoff
	summary?: SessionSummary
}

/** globalStorage roots to search, honouring a `customStoragePath` if one is set. */
async function tumbleStorageRoots(context: vscode.ExtensionContext): Promise<string[]> {
	const base = await getStorageBasePath(context.globalStorageUri.fsPath)
	return [base]
}

function workspacePath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

export async function pickUpAgentSession(context: vscode.ExtensionContext): Promise<void> {
	const cwd = workspacePath()

	const items: PickItem[] = [
		...listHandoffs({ cwd, status: "open", to: "tumble-code", limit: 25 }).map(
			(handoff): PickItem => ({
				source: "handoff",
				handoff,
				label: `$(inbox) ${handoff.title}`,
				description: t("common:agentInterchange.handoff_from", {
					agent: AGENT_LABELS[handoff.from],
					when: handoff.updated.slice(0, 16).replace("T", " "),
				}),
			}),
		),
		...listClaudeSessions({ cwd, limit: 30 }).map(
			(summary): PickItem => ({
				source: "session",
				summary,
				label: `$(comment-discussion) ${summary.title}`,
				description: t("common:agentInterchange.session_from", {
					agent: AGENT_LABELS[summary.agent],
					when: new Date(summary.updatedAt).toISOString().slice(0, 16).replace("T", " "),
				}),
				detail: summary.gitBranch ? `$(git-branch) ${summary.gitBranch}` : undefined,
			}),
		),
	]

	if (items.length === 0) {
		vscode.window.showInformationMessage(t("common:agentInterchange.nothing_to_pick_up"))
		return
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: t("common:agentInterchange.pick_up_title"),
		placeHolder: t("common:agentInterchange.pick_up_placeholder"),
		matchOnDescription: true,
		matchOnDetail: true,
	})

	if (!picked) {
		return
	}

	const storageRoots = await tumbleStorageRoots(context)

	const prepared = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: t("common:agentInterchange.reading") },
		async () => {
			if (picked.source === "handoff") {
				const handoff = picked.handoff!
				// The document already holds the briefing, so a missing or since-deleted
				// source session degrades the pick-up rather than blocking it.
				return { text: handoffPrompt(handoff), handoff }
			}

			const summary = picked.summary!
			const session =
				summary.agent === "claude-code"
					? await readClaudeSession(summary.id)
					: await readTumbleSession(summary.id, { storageRoots })

			return session ? { text: sessionPrompt(renderBriefing(session), summary) } : undefined
		},
	)

	if (!prepared) {
		vscode.window.showWarningMessage(t("common:agentInterchange.read_failed"))
		return
	}

	const provider = await ClineProvider.getInstance()

	if (!provider) {
		vscode.window.showWarningMessage(t("common:agentInterchange.no_provider"))
		return
	}

	const task = await provider.createTask(prepared.text)

	if (prepared.handoff) {
		await updateHandoff(prepared.handoff.id, {
			status: "picked-up",
			pickedUpBy: "tumble-code",
			pickedUpSessionId: task.taskId,
			note: `picked up by ${AGENT_LABELS["tumble-code"]}`,
		})
	}
}

export async function handOffCurrentTask(context: vscode.ExtensionContext): Promise<void> {
	const provider = await ClineProvider.getInstance()
	const task = provider?.getCurrentTask()

	if (!task) {
		vscode.window.showWarningMessage(t("common:agentInterchange.no_current_task"))
		return
	}

	const answer = await vscode.window.showInputBox({
		title: t("common:agentInterchange.next_steps_title"),
		prompt: t("common:agentInterchange.next_steps_prompt"),
		placeHolder: t("common:agentInterchange.next_steps_placeholder"),
		ignoreFocusOut: true,
	})

	if (answer === undefined) {
		return
	}

	const nextSteps = answer
		.split(";")
		.map((step) => step.trim())
		.filter(Boolean)

	const storageRoots = await tumbleStorageRoots(context)
	const session = await readTumbleSession(task.taskId, { storageRoots })

	if (!session) {
		vscode.window.showWarningMessage(t("common:agentInterchange.read_failed"))
		return
	}

	const handoff = await createHandoff({ session, to: "claude-code", nextSteps })

	const open = t("common:agentInterchange.open_handoff")
	const choice = await vscode.window.showInformationMessage(
		t("common:agentInterchange.handoff_created", { agent: AGENT_LABELS["claude-code"], id: handoff.id }),
		open,
	)

	if (choice === open) {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(handoff.path))
		await vscode.window.showTextDocument(document, { preview: false })
	}
}

/**
 * The seed prompt.
 *
 * It says plainly that this is second-hand knowledge and that the files on disk
 * are the authority — a briefing describes a run that may have been interrupted,
 * reverted, or continued by hand afterwards.
 */
function sessionPrompt(briefing: string, summary: SessionSummary): string {
	return [
		`You are taking over work started in ${AGENT_LABELS[summary.agent]}. Below is a briefing derived from that session's transcript.`,
		"",
		"Treat it as a report, not as ground truth: verify the current state of the files and the branch before you change anything. Then continue the work, or ask what to do next if the goal is unclear.",
		"",
		"---",
		"",
		briefing,
	].join("\n")
}

function handoffPrompt(handoff: Handoff): string {
	return [
		`${AGENT_LABELS[handoff.from]} handed this task over to you. The document below is the briefing plus the steps it left.`,
		"",
		"Treat it as a report, not as ground truth: verify the current state of the files and the branch before you change anything.",
		"",
		"---",
		"",
		handoff.body,
	].join("\n")
}
