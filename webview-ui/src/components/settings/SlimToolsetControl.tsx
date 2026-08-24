import React, { useCallback } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"

interface SlimToolsetControlProps {
	slimToolset?: boolean
	slimHidesMcp?: boolean
	onChange: (field: "slimToolset" | "slimHidesMcp", value: any) => void
}

/**
 * Per-profile switch that shrinks the advertised tool set to one obvious tool
 * per job. Small models do not fail for lack of capability, they fail by
 * picking the wrong one of six editing verbs, so this is a profile-level
 * setting: bind the slim profile to the modes you run small models in and the
 * restriction follows every mode switch on its own.
 *
 * The MCP sub-checkbox only appears while the slim toolset is on, and it is
 * checked by default there because MCP schemas are the single largest part of
 * the tool prompt.
 */
export const SlimToolsetControl: React.FC<SlimToolsetControlProps> = ({ slimToolset, slimHidesMcp, onChange }) => {
	const { t } = useAppTranslation()

	const handleSlimToolsetChange = useCallback(
		(e: any) => {
			onChange("slimToolset", e.target.checked)
		},
		[onChange],
	)

	const handleSlimHidesMcpChange = useCallback(
		(e: any) => {
			onChange("slimHidesMcp", e.target.checked)
		},
		[onChange],
	)

	return (
		<div className="flex flex-col gap-1">
			<div>
				<VSCodeCheckbox checked={slimToolset ?? false} onChange={handleSlimToolsetChange}>
					<span className="font-medium">{t("settings:advanced.slimToolset.label")}</span>
				</VSCodeCheckbox>
				<div className="text-vscode-descriptionForeground text-sm">
					{t("settings:advanced.slimToolset.description")}
				</div>
			</div>
			{slimToolset && (
				<div className="ml-6">
					{/* Undefined means "hide MCP" while the slim toolset is on, so the
					    checkbox reads an unset value as checked. */}
					<VSCodeCheckbox checked={slimHidesMcp !== false} onChange={handleSlimHidesMcpChange}>
						<span className="font-medium">{t("settings:advanced.slimToolset.hideMcp.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm">
						{t("settings:advanced.slimToolset.hideMcp.description")}
					</div>
				</div>
			)}
		</div>
	)
}
