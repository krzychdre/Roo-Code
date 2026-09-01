import { memo } from "react"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"

/**
 * Persistent banner for extension-host storage failures (task history
 * store, provider profile persistence). Common under Remote SSH, where the
 * storage lives on the server and a full disk, quota or permissions problem
 * would otherwise surface only as a transient toast or a log line.
 *
 * Rendered above the chat and in the settings view. There is no
 * auto-dismiss: the banner disappears only when the extension host clears
 * the error after a successful storage operation (the state push carries
 * an empty `storageErrorMessage`).
 */
const StorageErrorBanner = () => {
	const { t } = useAppTranslation()
	const { storageErrorMessage } = useExtensionState()

	if (!storageErrorMessage) {
		return null
	}

	return (
		<div
			data-testid="storage-error-banner"
			className="px-4 py-2.5 border-b text-sm leading-normal text-vscode-foreground bg-[var(--vscode-inputValidation-errorBackground)] border-[var(--vscode-inputValidation-errorBorder)]">
			<div className="mb-0.5 font-bold">{t("common:storageError.banner")}</div>
			<div className="break-words whitespace-pre-wrap">{storageErrorMessage}</div>
			<button
				onClick={() => vscode.postMessage({ type: "openExtensionLogs" })}
				className="mt-1.5 underline cursor-pointer bg-transparent border-none p-0 text-vscode-textLink-foreground hover:opacity-80">
				{t("common:storageError.showLogs")}
			</button>
		</div>
	)
}

export default memo(StorageErrorBanner)
