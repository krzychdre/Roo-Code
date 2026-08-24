import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Archive } from "lucide-react"

import type { ContextPrune } from "@roo-code/types"

interface PruneResultRowProps {
	data: ContextPrune
}

/**
 * Displays the result of a deterministic tool-result prune.
 *
 * This is the one context pass that rewrites what the user can scroll back
 * through: the full text of old, oversized tool results is moved to task
 * artifacts and the conversation keeps only a head/tail preview. The row exists
 * so that change is never silent, and so the expanded description can say where
 * the text went and how the model gets it back.
 */
export function PruneResultRow({ data }: PruneResultRowProps) {
	const { t } = useTranslation()
	const [isExpanded, setIsExpanded] = useState(false)

	const { prunedCount, bytesSaved, prevContextTokens, newContextTokens } = data

	// Handle null/undefined values to prevent crashes.
	const count = prunedCount ?? 0
	const kb = Math.max(1, Math.round((bytesSaved ?? 0) / 1024))
	const prevTokens = prevContextTokens ?? 0
	const newTokens = newContextTokens ?? 0

	return (
		<div className="mb-2">
			<div
				className="flex items-center justify-between cursor-pointer select-none"
				onClick={() => setIsExpanded(!isExpanded)}>
				<div className="flex items-center gap-2 flex-grow">
					<Archive size={16} className="text-vscode-foreground" />
					<span className="font-bold text-vscode-foreground">{t("chat:contextManagement.prune.title")}</span>
					<span className="text-vscode-descriptionForeground text-sm">
						{prevTokens.toLocaleString()} → {newTokens.toLocaleString()}{" "}
						{t("chat:contextManagement.tokens")}
					</span>
				</div>
				<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"}`}></span>
			</div>

			{isExpanded && (
				<div className="mt-2 ml-0 p-4 bg-vscode-editor-background rounded text-vscode-foreground text-sm">
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<span className="text-vscode-descriptionForeground">
								{t("chat:contextManagement.prune.summary", { count, kb })}
							</span>
						</div>
						<p className="text-vscode-descriptionForeground text-xs">
							{t("chat:contextManagement.prune.description")}
						</p>
					</div>
				</div>
			)}
		</div>
	)
}
