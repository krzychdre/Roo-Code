import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { WEB_TOOLS_DEFAULTS } from "@roo-code/types"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { Slider } from "@/components/ui"

type WebToolsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	webToolsEnabled?: boolean
	searxngBaseUrl?: string
	webSearchMaxResults?: number
	setCachedStateField: SetCachedStateField<"webToolsEnabled" | "searxngBaseUrl" | "webSearchMaxResults">
}

export const WebToolsSettings = ({
	webToolsEnabled,
	searxngBaseUrl,
	webSearchMaxResults,
	setCachedStateField,
	...props
}: WebToolsSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.web")}</SectionHeader>

			<Section>
				<SearchableSetting settingId="web-enable" section="web" label={t("settings:web.enable.label")}>
					<VSCodeCheckbox
						checked={webToolsEnabled ?? false}
						onChange={(e: any) => {
							setCachedStateField("webToolsEnabled", e.target.checked)
						}}
						data-testid="web-tools-enabled-checkbox">
						<span className="font-medium">{t("settings:web.enable.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:web.enable.description")}
					</div>
				</SearchableSetting>

				{webToolsEnabled && (
					<>
						<SearchableSetting
							settingId="web-searxng-url"
							section="web"
							label={t("settings:web.searxngBaseUrl.label")}
							className="mt-4">
							<label className="block text-sm font-medium mb-2">
								{t("settings:web.searxngBaseUrl.label")}
							</label>
							<VSCodeTextField
								value={searxngBaseUrl ?? ""}
								placeholder={t("settings:web.searxngBaseUrl.placeholder")}
								onInput={(e: any) => {
									setCachedStateField("searxngBaseUrl", e.target.value)
								}}
								className="w-full"
								data-testid="web-searxng-url-input"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:web.searxngBaseUrl.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="web-max-results"
							section="web"
							label={t("settings:web.maxResults.label")}
							className="mt-4">
							<label className="block text-sm font-medium mb-2">
								{t("settings:web.maxResults.label")}
							</label>
							<div className="flex items-center gap-2">
								<Slider
									min={WEB_TOOLS_DEFAULTS.MIN_SEARCH_RESULTS}
									max={WEB_TOOLS_DEFAULTS.MAX_SEARCH_RESULTS}
									step={1}
									defaultValue={[webSearchMaxResults ?? WEB_TOOLS_DEFAULTS.DEFAULT_SEARCH_RESULTS]}
									onValueChange={([value]) => {
										setCachedStateField("webSearchMaxResults", value)
									}}
									className="flex-1"
									data-testid="web-max-results-slider"
								/>
								<span className="w-12 text-center">
									{webSearchMaxResults ?? WEB_TOOLS_DEFAULTS.DEFAULT_SEARCH_RESULTS}
								</span>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:web.maxResults.description")}
							</div>
						</SearchableSetting>
					</>
				)}
			</Section>
		</div>
	)
}
