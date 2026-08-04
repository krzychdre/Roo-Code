import * as fsPromises from "node:fs/promises"

import { updateHandoff } from "../../handoffs.js"

const id = process.env.HANDOFF_ID!
const status = process.env.HANDOFF_STATUS as "picked-up" | "done"
const note = process.env.HANDOFF_NOTE!
const marker = process.env.HANDOFF_RENAME_MARKER
const delayMs = Number(process.env.HANDOFF_RENAME_DELAY_MS ?? 0)

const updated = await updateHandoff(
	id,
	{ status, note },
	{
		rename: async (source, destination) => {
			if (marker) {
				await fsPromises.writeFile(marker, "ready", "utf8")
			}
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs))
			}
			await fsPromises.rename(source, destination)
		},
	},
)

if (!updated) {
	throw new Error(`Handoff ${id} was not found`)
}
