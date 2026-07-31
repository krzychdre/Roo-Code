import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"

import type { ProviderSettingsEntry } from "@roo-code/types"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider } from "@/components/ui"

type MemorySettingsProps = HTMLAttributes<HTMLDivElement> & {
	autoMemoryEnabled?: boolean
	autoMemoryDirectory?: string
	autoMemoryShareWithClaudeCode?: boolean
	memoryRecallEnabled?: boolean
	autoDreamEnabled?: boolean
	autoDreamMinHours?: number
	autoDreamMinSessions?: number
	memoryWriterApiConfigId?: string
	listApiConfigMeta: ProviderSettingsEntry[]
	setCachedStateField: SetCachedStateField<
		| "autoMemoryEnabled"
		| "autoMemoryDirectory"
		| "autoMemoryShareWithClaudeCode"
		| "memoryRecallEnabled"
		| "autoDreamEnabled"
		| "autoDreamMinHours"
		| "autoDreamMinSessions"
		| "memoryWriterApiConfigId"
	>
}

// Radix Select rejects empty-string item values; "-" is safe because profile
// ids are nanoid-generated (same sentinel as PromptsSettings).
const UNSET_PROFILE = "-"

const MIN_DREAM_HOURS = 1
const MAX_DREAM_HOURS = 168 // 1 week
const DEFAULT_DREAM_HOURS = 24

const MIN_DREAM_SESSIONS = 1
const MAX_DREAM_SESSIONS = 100
const DEFAULT_DREAM_SESSIONS = 5

export const MemorySettings = ({
	autoMemoryEnabled,
	autoMemoryDirectory,
	autoMemoryShareWithClaudeCode,
	memoryRecallEnabled,
	autoDreamEnabled,
	autoDreamMinHours,
	autoDreamMinSessions,
	memoryWriterApiConfigId,
	listApiConfigMeta,
	setCachedStateField,
	...props
}: MemorySettingsProps) => {
	const { t } = useAppTranslation()
	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.memory")}</SectionHeader>

			<Section>
				<SearchableSetting settingId="memory-enable" section="memory" label={t("settings:memory.enable.label")}>
					<VSCodeCheckbox
						checked={autoMemoryEnabled ?? true}
						onChange={(e: any) => {
							setCachedStateField("autoMemoryEnabled", e.target.checked)
						}}>
						<span className="font-medium">{t("settings:memory.enable.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						<Trans i18nKey="settings:memory.enable.description">
							<VSCodeLink href="https://docs.roocode.com/features/memory" style={{ display: "inline" }}>
								{" "}
							</VSCodeLink>
						</Trans>
					</div>
				</SearchableSetting>

				{autoMemoryEnabled && (
					<>
						<SearchableSetting
							settingId="memory-recall"
							section="memory"
							label={t("settings:memory.recall.label")}
							className="mt-4">
							<VSCodeCheckbox
								checked={memoryRecallEnabled ?? true}
								onChange={(e: any) => {
									setCachedStateField("memoryRecallEnabled", e.target.checked)
								}}>
								<span className="font-medium">{t("settings:memory.recall.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:memory.recall.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="memory-directory"
							section="memory"
							label={t("settings:memory.directory.label")}
							className="mt-4">
							<label className="block text-sm font-medium mb-2">
								{t("settings:memory.directory.label")}
							</label>
							<VSCodeTextField
								value={autoMemoryDirectory ?? ""}
								placeholder={t("settings:memory.directory.placeholder")}
								onInput={(e: any) => {
									setCachedStateField("autoMemoryDirectory", e.target.value || undefined)
								}}
								className="w-full"
								data-testid="memory-directory-input"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:memory.directory.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="memory-share-claude-code"
							section="memory"
							label={t("settings:memory.shareWithClaudeCode.label")}
							className="mt-4">
							<VSCodeCheckbox
								checked={autoMemoryShareWithClaudeCode ?? false}
								disabled={!!autoMemoryDirectory}
								onChange={(e: any) => {
									setCachedStateField("autoMemoryShareWithClaudeCode", e.target.checked)
								}}
								data-testid="memory-share-claude-code-checkbox">
								<span className="font-medium">{t("settings:memory.shareWithClaudeCode.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{autoMemoryDirectory
									? t("settings:memory.shareWithClaudeCode.overridden")
									: t("settings:memory.shareWithClaudeCode.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="memory-writer-profile"
							section="memory"
							label={t("settings:memory.writerProfile.label")}
							className="mt-4">
							<label className="block text-sm font-medium mb-2">
								{t("settings:memory.writerProfile.label")}
							</label>
							<Select
								value={memoryWriterApiConfigId ?? UNSET_PROFILE}
								onValueChange={(value) => {
									setCachedStateField(
										"memoryWriterApiConfigId",
										value === UNSET_PROFILE ? undefined : value,
									)
								}}
								data-testid="memory-writer-profile-select">
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:memory.writerProfile.useCurrent")} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={UNSET_PROFILE}>
										{t("settings:memory.writerProfile.useCurrent")}
									</SelectItem>
									{listApiConfigMeta.map((config) => (
										<SelectItem key={config.id} value={config.id}>
											{config.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:memory.writerProfile.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="memory-dream-enable"
							section="memory"
							label={t("settings:memory.dream.enable.label")}
							className="mt-4">
							<VSCodeCheckbox
								checked={autoDreamEnabled ?? true}
								onChange={(e: any) => {
									setCachedStateField("autoDreamEnabled", e.target.checked)
								}}>
								<span className="font-medium">{t("settings:memory.dream.enable.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:memory.dream.enable.description")}
							</div>
						</SearchableSetting>

						{autoDreamEnabled && (
							<>
								<SearchableSetting
									settingId="memory-dream-hours"
									section="memory"
									label={t("settings:memory.dream.minHours.label")}
									className="mt-4">
									<label className="block text-sm font-medium mb-2">
										{t("settings:memory.dream.minHours.label")}
									</label>
									<div className="flex items-center gap-2">
										<Slider
											min={MIN_DREAM_HOURS}
											max={MAX_DREAM_HOURS}
											step={1}
											defaultValue={[autoDreamMinHours ?? DEFAULT_DREAM_HOURS]}
											onValueChange={([value]) => {
												setCachedStateField("autoDreamMinHours", value)
											}}
											className="flex-1"
											data-testid="memory-dream-hours-slider"
										/>
										<span className="w-12 text-center">
											{autoDreamMinHours ?? DEFAULT_DREAM_HOURS}
										</span>
									</div>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:memory.dream.minHours.description")}
									</div>
								</SearchableSetting>

								<SearchableSetting
									settingId="memory-dream-sessions"
									section="memory"
									label={t("settings:memory.dream.minSessions.label")}
									className="mt-4">
									<label className="block text-sm font-medium mb-2">
										{t("settings:memory.dream.minSessions.label")}
									</label>
									<div className="flex items-center gap-2">
										<Slider
											min={MIN_DREAM_SESSIONS}
											max={MAX_DREAM_SESSIONS}
											step={1}
											defaultValue={[autoDreamMinSessions ?? DEFAULT_DREAM_SESSIONS]}
											onValueChange={([value]) => {
												setCachedStateField("autoDreamMinSessions", value)
											}}
											className="flex-1"
											data-testid="memory-dream-sessions-slider"
										/>
										<span className="w-12 text-center">
											{autoDreamMinSessions ?? DEFAULT_DREAM_SESSIONS}
										</span>
									</div>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:memory.dream.minSessions.description")}
									</div>
								</SearchableSetting>
							</>
						)}
					</>
				)}
			</Section>
		</div>
	)
}
