import { randomUUID } from "node:crypto"
import { ExtensionContext } from "vscode"
import { z, ZodError } from "zod"
import deepEqual from "fast-deep-equal"

import {
	classifyProvider,
	createKnownPersistedProviderProfile,
	createProviderProfilesEnvelope,
	extractLegacyInlineSecrets,
	migrateProviderProfiles,
	opaqueProviderProfileSchema,
	providerProfileToLegacySettings,
	providerProfilesDataSchema,
	type OpaqueProviderProfile,
	type PersistedProviderProfile,
	type ProviderProfilesData,
	type ProviderProfilesEnvelope,
	type ProviderSettings,
	type ProviderSettingsWithId,
	SECRET_STATE_KEYS,
	providerSettingsWithIdSchema,
	isSecretStateKey,
	ProviderSettingsEntry,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	getModelId,
	type ProviderName,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Mode, modes } from "../../shared/modes"
import { buildApiHandler } from "../../api"

// Type-safe model migrations mapping
type ModelMigrations = {
	[K in ProviderName]?: Record<string, string>
}

const MODEL_MIGRATIONS: ModelMigrations = {} as const satisfies ModelMigrations

/**
 * Detect a pre-v2 (flat, un-versioned) provider-profiles envelope and return
 * its raw `apiConfigs` record so {@link ProviderSettingsManager.initialize}
 * can seed `provider_profile_secrets_v2` from inline secrets before the v2
 * rewrite. Returns undefined for already-versioned v2 envelopes (secrets are
 * already in the secret store) or malformed payloads.
 *
 * A flat apiConfig is one that still carries inline fields (e.g. `apiProvider`,
 * `apiKey`) rather than the v2 `{ provider: { providerId, config } }` shape.
 */
const extractRawFlatApiConfigs = (raw: unknown): Record<string, Record<string, unknown>> | undefined => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
	const envelope = raw as Record<string, unknown>
	// Already-versioned envelopes have their secrets routed via the v2 store
	// path on save; only un-versioned (legacy flat) envelopes need seeding.
	if ("schemaVersion" in envelope) return undefined
	const apiConfigs = envelope.apiConfigs
	if (typeof apiConfigs !== "object" || apiConfigs === null || Array.isArray(apiConfigs)) return undefined
	const configs = apiConfigs as Record<string, unknown>
	const flat: Record<string, Record<string, unknown>> = {}
	for (const [name, value] of Object.entries(configs)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue
		const profile = value as Record<string, unknown>
		// v2-shaped profiles have a nested `provider` object; skip them. Only
		// flat (legacy) profiles carry inline secrets that need seeding.
		if (typeof profile.provider === "object" && profile.provider !== null) continue
		flat[name] = profile
	}
	return Object.keys(flat).length > 0 ? flat : undefined
}

export interface SyncCloudProfilesResult {
	hasChanges: boolean
	activeProfileChanged: boolean
	activeProfileId: string
}

/** @deprecated Stage 6 flat fixtures remain accepted at this test/import boundary only. */
export type ProviderProfilesInput = Pick<
	ProviderProfilesData,
	"currentApiConfigName" | "modeApiConfigs" | "cloudProfileIds" | "migrations"
> & {
	apiConfigs: Record<string, ProviderSettingsWithId | (PersistedProviderProfile & Partial<ProviderSettingsWithId>)>
}
/** @deprecated Stage 6 flat fixture alias retained for external test compatibility. */
export type ProviderProfiles = ProviderProfilesInput

export const providerProfilesSchema = providerProfilesDataSchema

export class ProviderSettingsManager {
	private static readonly SCOPE_PREFIX = "roo_cline_config_"
	private readonly defaultConfigId = this.generateId()

	private readonly defaultModeApiConfigs: Record<string, string> = Object.fromEntries(
		modes.map((mode) => [mode.slug, this.defaultConfigId]),
	)

	private readonly defaultProviderProfiles: ProviderProfilesData = {
		currentApiConfigName: "default",
		apiConfigs: {
			default: { id: this.defaultConfigId, provider: { providerId: "anthropic", config: {} } },
		},
		modeApiConfigs: this.defaultModeApiConfigs,
		migrations: {
			rateLimitSecondsMigrated: true, // Mark as migrated on fresh installs
			openAiHeadersMigrated: true, // Mark as migrated on fresh installs
			consecutiveMistakeLimitMigrated: true, // Mark as migrated on fresh installs
			todoListEnabledMigrated: true, // Mark as migrated on fresh installs
			claudeCodeLegacySettingsMigrated: true, // Mark as migrated on fresh installs
		},
	}

	private loadedEnvelope: ProviderProfilesEnvelope | undefined

	private readonly context: ExtensionContext

	constructor(context: ExtensionContext) {
		this.context = context

		// TODO: We really shouldn't have async methods in the constructor.
		this.initialize().catch(console.error)
	}

	public generateId() {
		// CSPRNG id so profileId (which indexes stored secrets via
		// allSecrets[profileId]) is not predictable. Previously used
		// Math.random() — a non-cryptographic PRNG (CodeQL #9/#10).
		return randomUUID()
	}

	// Synchronize readConfig/writeConfig operations to avoid data loss.
	private _lock = Promise.resolve()
	private lock<T>(cb: () => Promise<T>) {
		const next = this._lock.then(cb)
		this._lock = next.catch(() => {}) as Promise<void>
		return next
	}

	private isOpaqueProfile(profile: PersistedProviderProfile): profile is OpaqueProviderProfile {
		return !("config" in profile.provider)
	}

	private async toProviderSettings(profile: PersistedProviderProfile): Promise<ProviderSettingsWithId> {
		// Secrets live in `provider_profile_secrets_v2` for BOTH known and
		// opaque profiles (C1/C3). Opaque retired/unknown profiles no longer
		// carry inline SECRET_STATE_KEYS in their `opaqueLegacyPayload`, so the
		// secret store is the only source for them at read time.
		const secrets = profile.id ? (await this.loadProfileSecrets())[profile.id] : undefined
		if (this.isOpaqueProfile(profile)) {
			return {
				id: profile.id,
				...structuredClone(profile.provider.opaqueLegacyPayload),
				...(secrets ?? {}),
			} as ProviderSettingsWithId
		}

		return { id: profile.id, ...providerProfileToLegacySettings(profile), ...(secrets ?? {}) }
	}

	private get profileSecretsKey() {
		return `${ProviderSettingsManager.SCOPE_PREFIX}provider_profile_secrets_v2`
	}

	private async loadProfileSecrets(): Promise<Record<string, Record<string, unknown>>> {
		const value = await this.context.secrets.get(this.profileSecretsKey)
		if (!value) return {}
		let parsed: unknown
		try {
			parsed = JSON.parse(value)
		} catch {
			return {}
		}
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, Record<string, unknown>>)
			: {}
	}

	private async storeProfileSecrets(value: Record<string, Record<string, unknown>>): Promise<void> {
		if (Object.keys(value).length === 0) {
			await this.context.secrets.delete(this.profileSecretsKey)
			return
		}
		await this.context.secrets.store(this.profileSecretsKey, JSON.stringify(value))
	}

	private async updateProfileSecrets(profileId: string, config: ProviderSettingsWithId): Promise<void> {
		const allSecrets = await this.loadProfileSecrets()
		const hadProfileSecrets = profileId in allSecrets
		const profileSecrets = { ...(allSecrets[profileId] ?? {}) }
		for (const key of SECRET_STATE_KEYS) {
			const value = config[key]
			if (value === undefined) delete profileSecrets[key]
			else profileSecrets[key] = value
		}
		if (Object.keys(profileSecrets).length > 0) allSecrets[profileId] = profileSecrets
		else delete allSecrets[profileId]
		if (Object.keys(profileSecrets).length > 0 || hadProfileSecrets) await this.storeProfileSecrets(allSecrets)
	}

	private async deleteProfileSecrets(profileId: string): Promise<void> {
		const allSecrets = await this.loadProfileSecrets()
		if (!(profileId in allSecrets)) return
		delete allSecrets[profileId]
		await this.storeProfileSecrets(allSecrets)
	}

	/**
	 * Initialize config if it doesn't exist and run migrations.
	 */
	public async initialize() {
		try {
			return await this.lock(async () => {
				// Capture the raw pre-migration payload before load() rewrites
				// it into the v2 envelope, so we can seed
				// `provider_profile_secrets_v2` from legacy inline secrets. This
				// prevents first-run upgrade from silently dropping every
				// existing API key (C1) and ensures opaque retired/unknown
				// profiles no longer persist plaintext secrets on disk (C3).
				const rawEnvelope = await this.readRawEnvelope()
				const rawApiConfigs = extractRawFlatApiConfigs(rawEnvelope)

				const providerProfiles = await this.load()

				// Seed the secret store BEFORE store() rewrites the envelope.
				// Both known-provider flat profiles and opaque flat profiles
				// are handled: known profiles lose their inline secrets via
				// pickPresent(providerFieldOwnership[...]); opaque profiles
				// lose them via stripSecretStateKeys in the migration path.
				if (rawApiConfigs) {
					for (const [_name, profile] of Object.entries(rawApiConfigs)) {
						const profileId = typeof profile.id === "string" ? profile.id : undefined
						if (!profileId) continue
						const secrets = extractLegacyInlineSecrets(profile)
						if (Object.keys(secrets).length === 0) continue
						await this.updateProfileSecrets(profileId, {
							id: profileId,
							...secrets,
						} as ProviderSettingsWithId)
					}
				}

				let isDirty = false

				// Migrate existing installs to have per-mode API config map
				if (!providerProfiles.modeApiConfigs) {
					// Use the currently selected config for all modes initially
					const currentName = providerProfiles.currentApiConfigName
					const seedId =
						providerProfiles.apiConfigs[currentName]?.id ??
						Object.values(providerProfiles.apiConfigs)[0]?.id ??
						this.defaultConfigId
					providerProfiles.modeApiConfigs = Object.fromEntries(modes.map((m) => [m.slug, seedId]))
					isDirty = true
				}

				// Apply model migrations for all providers
				if (this.applyModelMigrations(providerProfiles)) {
					isDirty = true
				}

				// Ensure all configs have IDs.
				for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
					if (!apiConfig.id) {
						apiConfig.id = this.generateId()
						isDirty = true
					}
				}

				// Ensure migrations field exists
				if (!providerProfiles.migrations) {
					providerProfiles.migrations = {
						rateLimitSecondsMigrated: false,
						openAiHeadersMigrated: false,
						consecutiveMistakeLimitMigrated: false,
						todoListEnabledMigrated: false,
						claudeCodeLegacySettingsMigrated: false,
					} // Initialize with default values
					isDirty = true
				}

				if (!providerProfiles.migrations.rateLimitSecondsMigrated) {
					await this.migrateRateLimitSeconds(providerProfiles)
					providerProfiles.migrations.rateLimitSecondsMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.openAiHeadersMigrated) {
					await this.migrateOpenAiHeaders(providerProfiles)
					providerProfiles.migrations.openAiHeadersMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.consecutiveMistakeLimitMigrated) {
					await this.migrateConsecutiveMistakeLimit(providerProfiles)
					providerProfiles.migrations.consecutiveMistakeLimitMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.todoListEnabledMigrated) {
					await this.migrateTodoListEnabled(providerProfiles)
					providerProfiles.migrations.todoListEnabledMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.claudeCodeLegacySettingsMigrated) {
					// These keys were used by the removed local Claude Code CLI wrapper.
					for (const apiConfig of Object.values(providerProfiles.apiConfigs)) {
						if (!this.isOpaqueProfile(apiConfig)) continue
						const config = apiConfig.provider.opaqueLegacyPayload
						if (config.apiProvider !== "claude-code") continue

						if ("claudeCodePath" in config) {
							delete config.claudeCodePath
							isDirty = true
						}
						if ("claudeCodeMaxOutputTokens" in config) {
							delete config.claudeCodeMaxOutputTokens
							isDirty = true
						}
					}

					providerProfiles.migrations.claudeCodeLegacySettingsMigrated = true
					isDirty = true
				}

				if (isDirty) {
					await this.store(providerProfiles)
				} else if (this.loadedEnvelope === undefined) {
					await this.store(providerProfiles)
				}
			})
		} catch (error) {
			throw new Error(`Failed to initialize config: ${error}`)
		}
	}

	private async migrateRateLimitSeconds(providerProfiles: ProviderProfilesData) {
		try {
			let rateLimitSeconds: number | undefined

			try {
				rateLimitSeconds = await this.context.globalState.get<number>("rateLimitSeconds")
			} catch (error) {
				console.error("[MigrateRateLimitSeconds] Error getting global rate limit:", error)
			}

			if (rateLimitSeconds === undefined) {
				// Failed to get the existing value, use the default.
				rateLimitSeconds = 0
			}

			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (this.isOpaqueProfile(apiConfig)) {
					if (apiConfig.provider.opaqueLegacyPayload.rateLimitSeconds === undefined) {
						apiConfig.provider.opaqueLegacyPayload.rateLimitSeconds = rateLimitSeconds
					}
				} else {
					apiConfig.shared ??= {}
					if (apiConfig.shared.rateLimitSeconds === undefined)
						apiConfig.shared.rateLimitSeconds = rateLimitSeconds
				}
			}
		} catch (error) {
			console.error(`[MigrateRateLimitSeconds] Failed to migrate rate limit settings:`, error)
		}
	}

	private async migrateOpenAiHeaders(providerProfiles: ProviderProfilesData) {
		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (this.isOpaqueProfile(apiConfig) || apiConfig.provider.providerId !== "openai") continue
				const config = apiConfig.provider.config

				// Check if openAiHostHeader exists but openAiHeaders doesn't
				if (
					config.openAiHostHeader &&
					(!config.openAiHeaders || Object.keys(config.openAiHeaders).length === 0)
				) {
					// Create the headers object with the Host value
					config.openAiHeaders = { Host: config.openAiHostHeader }

					// Delete the old property to prevent re-migration
					// This prevents the header from reappearing after deletion
					config.openAiHostHeader = undefined
				}
			}
		} catch (error) {
			console.error(`[MigrateOpenAiHeaders] Failed to migrate OpenAI headers:`, error)
		}
	}

	private async migrateConsecutiveMistakeLimit(providerProfiles: ProviderProfilesData) {
		try {
			for (const profile of Object.values(providerProfiles.apiConfigs)) {
				if (this.isOpaqueProfile(profile)) {
					profile.provider.opaqueLegacyPayload.consecutiveMistakeLimit ??= DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
				} else {
					profile.shared ??= {}
					profile.shared.consecutiveMistakeLimit ??= DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
				}
			}
		} catch (error) {
			console.error(`[MigrateConsecutiveMistakeLimit] Failed to migrate consecutive mistake limit:`, error)
		}
	}

	private async migrateTodoListEnabled(providerProfiles: ProviderProfilesData) {
		try {
			for (const profile of Object.values(providerProfiles.apiConfigs)) {
				if (this.isOpaqueProfile(profile)) profile.provider.opaqueLegacyPayload.todoListEnabled ??= true
				else {
					profile.shared ??= {}
					profile.shared.todoListEnabled ??= true
				}
			}
		} catch (error) {
			console.error(`[MigrateTodoListEnabled] Failed to migrate todo list enabled setting:`, error)
		}
	}

	/**
	 * Apply model migrations for all providers
	 * Returns true if any migrations were applied
	 */
	private applyModelMigrations(providerProfiles: ProviderProfilesData): boolean {
		let migrated = false

		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (this.isOpaqueProfile(apiConfig) || !("apiModelId" in apiConfig.provider.config)) continue
				const modelId = apiConfig.provider.config.apiModelId
				// Skip configs without provider or model ID
				if (!modelId) {
					continue
				}

				// Check if this provider has migrations (with type safety)
				const provider = apiConfig.provider.providerId
				const providerMigrations = MODEL_MIGRATIONS[provider]
				if (!providerMigrations) {
					continue
				}

				// Check if the current model ID needs migration
				const newModelId = providerMigrations[modelId]
				if (newModelId && newModelId !== modelId) {
					console.log(`[ModelMigration] Migrating ${provider} model from ${modelId} to ${newModelId}`)
					apiConfig.provider.config.apiModelId = newModelId
					migrated = true
				}
			}
		} catch (error) {
			console.error(`[ModelMigration] Failed to apply model migrations:`, error)
		}

		return migrated
	}

	/**
	 * Clean model ID by removing prefix before "/"
	 */
	private cleanModelId(modelId: string | undefined): string | undefined {
		if (!modelId) return undefined

		// Check for "/" and take the part after it
		if (modelId.includes("/")) {
			return modelId.split("/").pop()
		}

		return modelId
	}

	/**
	 * List all available configs with metadata.
	 */
	public async listConfig(): Promise<ProviderSettingsEntry[]> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				return await Promise.all(
					Object.entries(providerProfiles.apiConfigs).map(async ([name, persistedProfile]) => {
						const apiConfig = await this.toProviderSettings(persistedProfile)
						return {
							name,
							id: persistedProfile.id || "",
							apiProvider: apiConfig.apiProvider as ProviderSettingsEntry["apiProvider"],
							...(getModelId(apiConfig) ? { modelId: this.cleanModelId(getModelId(apiConfig)) } : {}),
						}
					}),
				)
			})
		} catch (error) {
			throw new Error(`Failed to list configs: ${error}`)
		}
	}

	/**
	 * Save a config with the given name.
	 * Preserves the ID from the input 'config' object if it exists,
	 * otherwise generates a new one (for creation scenarios).
	 */
	public async saveConfig(name: string, config: ProviderSettingsWithId): Promise<string> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				// Preserve the existing ID if this is an update to an existing config.
				const existingId = providerProfiles.apiConfigs[name]?.id
				const id = config.id || existingId || this.generateId()

				// For active providers, filter out settings from other providers.
				// For retired providers, preserve full profile fields (including legacy
				// provider-specific keys) to avoid data loss — passthrough() keeps
				// unknown keys that strict parse() would strip.
				const classification = classifyProvider(config.apiProvider)
				const plaintextConfig = { ...config }
				for (const key of SECRET_STATE_KEYS) delete plaintextConfig[key]
				providerProfiles.apiConfigs[name] =
					classification === "retired" || classification === "unknown"
						? opaqueProviderProfileSchema.parse({
								id,
								provider: {
									providerId: config.apiProvider ?? "unknown",
									opaqueLegacyPayload: structuredClone(plaintextConfig),
								},
							})
						: createKnownPersistedProviderProfile({ ...plaintextConfig, id })
				await this.store(providerProfiles)
				await this.updateProfileSecrets(id, config)
				return id
			})
		} catch (error) {
			throw new Error(`Failed to save config: ${error}`)
		}
	}

	public async getProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				let name: string
				let providerSettings: PersistedProviderProfile

				if ("name" in params) {
					name = params.name

					if (!providerProfiles.apiConfigs[name]) {
						throw new Error(`Config with name '${name}' not found`)
					}

					providerSettings = providerProfiles.apiConfigs[name]
				} else {
					const id = params.id

					const entry = Object.entries(providerProfiles.apiConfigs).find(
						([_, apiConfig]) => apiConfig.id === id,
					)

					if (!entry) {
						throw new Error(`Config with ID '${id}' not found`)
					}

					name = entry[0]
					providerSettings = entry[1]
				}

				return { name, ...(await this.toProviderSettings(providerSettings)) }
			})
		} catch (error) {
			throw new Error(`Failed to get profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Activate a profile by name or ID.
	 */
	public async activateProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		const { name, ...providerSettings } = await this.getProfile(params)
		const classification = classifyProvider(providerSettings.apiProvider)
		if (classification === "retired" || classification === "unknown") {
			throw new Error(
				`Provider '${providerSettings.apiProvider ?? "unknown"}' is unavailable and cannot be activated.`,
			)
		}

		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				providerProfiles.currentApiConfigName = name
				await this.store(providerProfiles)
				return { name, ...providerSettings }
			})
		} catch (error) {
			throw new Error(`Failed to activate profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Delete a config by name.
	 */
	public async deleteConfig(name: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				if (!providerProfiles.apiConfigs[name]) {
					throw new Error(`Config '${name}' not found`)
				}

				if (Object.keys(providerProfiles.apiConfigs).length === 1) {
					throw new Error(`Cannot delete the last remaining configuration`)
				}

				const profileId = providerProfiles.apiConfigs[name].id
				delete providerProfiles.apiConfigs[name]
				await this.store(providerProfiles)
				if (profileId) await this.deleteProfileSecrets(profileId)
			})
		} catch (error) {
			throw new Error(`Failed to delete config: ${error}`)
		}
	}

	/**
	 * Check if a config exists by name.
	 */
	public async hasConfig(name: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				return name in providerProfiles.apiConfigs
			})
		} catch (error) {
			throw new Error(`Failed to check config existence: ${error}`)
		}
	}

	/**
	 * Set the API config for a specific mode.
	 */
	public async setModeConfig(mode: Mode, configId: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				// Ensure the per-mode config map exists
				if (!providerProfiles.modeApiConfigs) {
					providerProfiles.modeApiConfigs = {}
				}
				// Assign the chosen config ID to this mode
				providerProfiles.modeApiConfigs[mode] = configId
				await this.store(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to set mode config: ${error}`)
		}
	}

	/**
	 * Set the API config for many modes at once.
	 *
	 * Used to fast-assign the active profile to all (or a chosen subset of)
	 * modes in a single store round-trip, instead of one lock+store per mode.
	 */
	public async setModeConfigs(modes: Mode[], configId: string) {
		if (modes.length === 0) {
			return
		}

		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				// Ensure the per-mode config map exists
				if (!providerProfiles.modeApiConfigs) {
					providerProfiles.modeApiConfigs = {}
				}
				// Assign the chosen config ID to every listed mode
				for (const mode of modes) {
					providerProfiles.modeApiConfigs[mode] = configId
				}
				await this.store(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to set mode configs: ${error}`)
		}
	}

	/**
	 * Get the API config ID for a specific mode.
	 */
	public async getModeConfigId(mode: Mode) {
		try {
			return await this.lock(async () => {
				const { modeApiConfigs } = await this.load()
				return modeApiConfigs?.[mode]
			})
		} catch (error) {
			throw new Error(`Failed to get mode config: ${error}`)
		}
	}

	public async export(): Promise<ProviderProfilesInput> {
		try {
			return await this.lock(async () => {
				const profiles = structuredClone(providerProfilesSchema.parse(await this.load()))
				const configs = profiles.apiConfigs
				for (const name in configs) {
					const persistedProfile = configs[name]
					if (this.isOpaqueProfile(persistedProfile)) {
						// Preserve retired and future-provider profiles as opaque payloads.
						continue
					}

					// Try to build an API handler to get model information
					try {
						const apiHandler = buildApiHandler(providerProfileToLegacySettings(persistedProfile))
						const modelInfo = apiHandler.getModel().info

						// Check if the model supports reasoning budgets
						const supportsReasoningBudget =
							modelInfo.supportsReasoningBudget || modelInfo.requiredReasoningBudget

						// modelMaxThinkingTokens only applies to reasoning budgets, but modelMaxTokens
						// also caps output on models that expose a configurable max (e.g. GLM), so keep
						// it whenever the model supports either feature.
						const supportsMaxTokens = supportsReasoningBudget || modelInfo.supportsMaxTokens

						if (!supportsReasoningBudget) {
							delete persistedProfile.shared?.modelMaxThinkingTokens
						}

						if (!supportsMaxTokens) {
							delete persistedProfile.shared?.modelMaxTokens
						}
					} catch (error) {
						// If we can't build the API handler or get model info, skip filtering
						// to avoid accidental data loss from incomplete configurations
						console.warn(`Skipping token field filtering for config '${name}': ${error}`)
					}
				}
				return profiles
			})
		} catch (error) {
			throw new Error(`Failed to export provider profiles: ${error}`)
		}
	}

	public async import(providerProfiles: ProviderProfilesInput) {
		try {
			return await this.lock(async () => {
				const migratedEnvelope = migrateProviderProfiles(providerProfiles)
				this.loadedEnvelope = migratedEnvelope
				await this.store(migratedEnvelope.data)
				// Seed `provider_profile_secrets_v2` for every imported profile
				// that carries inline SECRET_STATE_KEYS. The import boundary in
				// `importExport.ts` re-attaches previously-known local secrets
				// (from `previousLegacyProfiles`) onto the flat representation
				// before calling `import()`, so we must capture them here for
				// BOTH flat (pre-v2) and v2-shaped inputs. Known-profile v2
				// configs drop secrets via `pickPresent(providerFieldOwnership[...])`
				// during `migrateProviderProfiles`, and opaque profiles drop
				// them via `stripSecretStateKeys`, so the persisted envelope
				// never carries plaintext secrets while the secret store keeps
				// them for `getProfile`/`activateProfile`.
				for (const profile of Object.values(providerProfiles.apiConfigs)) {
					const profileId = typeof profile.id === "string" ? profile.id : undefined
					if (!profileId) continue
					const secrets = extractLegacyInlineSecrets(profile as Record<string, unknown>)
					if (Object.keys(secrets).length > 0) {
						await this.updateProfileSecrets(profileId, {
							id: profileId,
							...secrets,
						} as ProviderSettingsWithId)
					}
				}
			})
		} catch (error) {
			throw new Error(`Failed to import provider profiles: ${error}`)
		}
	}

	/**
	 * Reset provider profiles by deleting them from secrets.
	 */
	public async resetAllConfigs() {
		return await this.lock(async () => {
			await this.context.secrets.delete(this.secretsKey)
		})
	}

	private get secretsKey() {
		return `${ProviderSettingsManager.SCOPE_PREFIX}api_config`
	}

	/**
	 * Read the raw (un-migrated) secrets-store payload. Returns the parsed
	 * JSON value (object, string, or null) exactly as stored. Used by
	 * {@link initialize} to detect pre-v2 flat profiles with inline secrets.
	 *
	 * Best-effort: if the secrets store itself is failing (e.g. storage error),
	 * return null so the subsequent `load()` call raises the properly-wrapped
	 * error rather than a duplicate raw one. This must never throw — it is a
	 * pre-flight capture step, not the authoritative read path.
	 */
	private async readRawEnvelope(): Promise<unknown> {
		let content: string | undefined
		try {
			content = await this.context.secrets.get(this.secretsKey)
		} catch {
			return null
		}
		if (!content) return null
		try {
			return JSON.parse(content)
		} catch {
			return null
		}
	}

	private async load(): Promise<ProviderProfilesData> {
		try {
			const content = await this.context.secrets.get(this.secretsKey)

			if (!content) {
				this.loadedEnvelope = createProviderProfilesEnvelope(this.defaultProviderProfiles)
				return this.defaultProviderProfiles
			}

			const rawValue = JSON.parse(content)
			const wasVersioned = typeof rawValue === "object" && rawValue !== null && "schemaVersion" in rawValue
			const envelope = migrateProviderProfiles(rawValue)
			this.loadedEnvelope = wasVersioned ? envelope : undefined
			return envelope.data
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({
					schemaName: "ProviderProfiles",
					error,
				})
			}

			throw new Error(`Failed to read provider profiles from secrets: ${error}`)
		}
	}

	private async store(providerProfiles: ProviderProfilesInput) {
		try {
			const apiConfigs = Object.fromEntries(
				Object.entries(providerProfiles.apiConfigs).map(([name, profile]) => [
					name,
					"provider" in profile ? profile : createKnownPersistedProviderProfile(profile),
				]),
			)
			const envelope = createProviderProfilesEnvelope({ ...providerProfiles, apiConfigs })
			this.loadedEnvelope = envelope
			await this.context.secrets.store(this.secretsKey, JSON.stringify(envelope, null, 2))
		} catch (error) {
			throw new Error(`Failed to write provider profiles to secrets: ${error}`)
		}
	}

	private findUniqueProfileName(baseName: string, existingNames: Set<string>): string {
		if (!existingNames.has(baseName)) {
			return baseName
		}

		// Try _local first
		const localName = `${baseName}_local`
		if (!existingNames.has(localName)) {
			return localName
		}

		// Try _1, _2, etc.
		let counter = 1
		let candidateName: string
		do {
			candidateName = `${baseName}_${counter}`
			counter++
		} while (existingNames.has(candidateName))

		return candidateName
	}

	public async syncCloudProfiles(
		cloudProfiles: Record<string, ProviderSettingsWithId>,
		currentActiveProfileName?: string,
	): Promise<SyncCloudProfilesResult> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				const changedProfiles: string[] = []
				const existingNames = new Set(Object.keys(providerProfiles.apiConfigs))

				let activeProfileChanged = false
				let activeProfileId = ""

				if (currentActiveProfileName && providerProfiles.apiConfigs[currentActiveProfileName]) {
					activeProfileId = providerProfiles.apiConfigs[currentActiveProfileName].id || ""
				}

				const currentCloudIds = new Set(providerProfiles.cloudProfileIds || [])
				const newCloudIds = new Set(
					Object.values(cloudProfiles)
						.map((p) => p.id)
						.filter((id): id is string => Boolean(id)),
				)

				// Step 1: Delete profiles that are cloud-managed but not in the new cloud profiles
				for (const [name, profile] of Object.entries(providerProfiles.apiConfigs)) {
					if (profile.id && currentCloudIds.has(profile.id) && !newCloudIds.has(profile.id)) {
						// Check if we're deleting the active profile
						if (name === currentActiveProfileName) {
							activeProfileChanged = true
							activeProfileId = "" // Clear the active profile ID since it's being deleted
						}
						delete providerProfiles.apiConfigs[name]
						changedProfiles.push(name)
						existingNames.delete(name)
					}
				}

				// Step 2: Process each cloud profile
				for (const [cloudName, cloudProfile] of Object.entries(cloudProfiles)) {
					if (!cloudProfile.id) {
						continue // Skip profiles without IDs
					}

					// Find existing profile with matching ID
					const existingEntry = Object.entries(providerProfiles.apiConfigs).find(
						([_, profile]) => profile.id === cloudProfile.id,
					)

					if (existingEntry) {
						// Step 3: Update existing profile
						const [existingName, existingProfile] = existingEntry

						// Check if this is the active profile
						const isActiveProfile = existingName === currentActiveProfileName

						// Merge settings, preserving secret keys
						const updatedProfile = createKnownPersistedProviderProfile({
							...(await this.toProviderSettings(existingProfile)),
							...cloudProfile,
						})
						const runtimeChanged = !deepEqual(await this.toProviderSettings(existingProfile), {
							...(await this.toProviderSettings(existingProfile)),
							...cloudProfile,
						})

						// Check if the profile actually changed using deepEqual
						const profileChanged = !deepEqual(existingProfile, updatedProfile)

						// Handle name change
						if (existingName !== cloudName) {
							// Remove old entry
							delete providerProfiles.apiConfigs[existingName]
							existingNames.delete(existingName)

							// Handle name conflict
							let finalName = cloudName
							if (existingNames.has(cloudName)) {
								// There's a conflict - rename the existing non-cloud profile
								const conflictingProfile = providerProfiles.apiConfigs[cloudName]
								if (conflictingProfile.id !== cloudProfile.id) {
									const newName = this.findUniqueProfileName(cloudName, existingNames)
									providerProfiles.apiConfigs[newName] = conflictingProfile
									existingNames.add(newName)
									changedProfiles.push(newName)
								}
								delete providerProfiles.apiConfigs[cloudName]
								existingNames.delete(cloudName)
							}

							// Add updated profile with new name
							providerProfiles.apiConfigs[finalName] = updatedProfile
							existingNames.add(finalName)
							changedProfiles.push(finalName)
							if (existingName !== finalName) {
								changedProfiles.push(existingName) // Mark old name as changed (deleted)
							}

							// If this was the active profile, mark it as changed
							if (isActiveProfile && runtimeChanged) {
								activeProfileChanged = true
								activeProfileId = cloudProfile.id || ""
							}
						} else if (profileChanged) {
							// Same name, but profile content changed - update in place
							providerProfiles.apiConfigs[existingName] = updatedProfile
							changedProfiles.push(existingName)

							// If this was the active profile and settings changed, mark it as changed
							if (isActiveProfile && runtimeChanged) {
								activeProfileChanged = true
								activeProfileId = cloudProfile.id || ""
							}
						}
						// If name is the same and profile hasn't changed, do nothing
					} else {
						// Step 4: Add new cloud profile
						let finalName = cloudName

						// Handle name conflict with existing non-cloud profile
						if (existingNames.has(cloudName)) {
							const existingProfile = providerProfiles.apiConfigs[cloudName]
							if (existingProfile.id !== cloudProfile.id) {
								// Rename the existing profile
								const newName = this.findUniqueProfileName(cloudName, existingNames)
								providerProfiles.apiConfigs[newName] = existingProfile
								existingNames.add(newName)
								changedProfiles.push(newName)

								// Remove the old entry
								delete providerProfiles.apiConfigs[cloudName]
								existingNames.delete(cloudName)
							}
						}

						// Add the new cloud profile (without secret keys)
						const newProfile = createKnownPersistedProviderProfile(cloudProfile)

						providerProfiles.apiConfigs[finalName] = newProfile
						existingNames.add(finalName)
						changedProfiles.push(finalName)
					}
				}

				// Step 5: Handle case where all profiles might be deleted
				if (Object.keys(providerProfiles.apiConfigs).length === 0 && changedProfiles.length > 0) {
					// Create a default profile only if we have changed profiles
					const defaultProfile: PersistedProviderProfile = {
						id: this.generateId(),
						provider: { providerId: "anthropic", config: {} },
					}
					providerProfiles.apiConfigs["default"] = defaultProfile
					activeProfileChanged = true
					activeProfileId = defaultProfile.id || ""
					changedProfiles.push("default")
				}

				// Step 6: If active profile was deleted, find a replacement
				if (activeProfileChanged && !activeProfileId) {
					const firstProfile = Object.values(providerProfiles.apiConfigs)[0]
					if (firstProfile?.id) {
						activeProfileId = firstProfile.id
					}
				}

				// Step 7: Update cloudProfileIds
				providerProfiles.cloudProfileIds = Array.from(newCloudIds)

				// Save the updated profiles
				await this.store(providerProfiles)

				return {
					hasChanges: changedProfiles.length > 0,
					activeProfileChanged,
					activeProfileId,
				}
			})
		} catch (error) {
			throw new Error(`Failed to sync cloud profiles: ${error}`)
		}
	}
}
