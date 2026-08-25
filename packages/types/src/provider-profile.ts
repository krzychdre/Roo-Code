import { z } from "zod"

import {
	narrowedProviderSettingsSchema,
	opaqueNarrowedProviderSettingsSchema,
	type KnownProviderId,
} from "./provider-config/index.js"
import { classifyProvider } from "./provider-registry.js"
import { providerSettingsSchema, type ProviderSettings, type ProviderSettingsWithId } from "./provider-settings.js"
import { SECRET_STATE_KEYS } from "./global-settings.js"

export const PROVIDER_PROFILES_SCHEMA_VERSION = 2 as const

export const providerProfileMigrationsSchema = z
	.object({
		rateLimitSecondsMigrated: z.boolean().optional(),
		openAiHeadersMigrated: z.boolean().optional(),
		consecutiveMistakeLimitMigrated: z.boolean().optional(),
		todoListEnabledMigrated: z.boolean().optional(),
		claudeCodeLegacySettingsMigrated: z.boolean().optional(),
	})
	.strict()

export type ProviderProfileMigrations = z.infer<typeof providerProfileMigrationsSchema>

export const knownPersistedProviderProfileSchema = z
	.object({ id: z.string().optional() })
	.merge(narrowedProviderSettingsSchema)
	.strict()
export const opaqueProviderProfileSchema = z
	.object({ id: z.string().optional() })
	.merge(opaqueNarrowedProviderSettingsSchema)
	.strict()
export const persistedProviderProfileSchema = z.union([
	knownPersistedProviderProfileSchema,
	opaqueProviderProfileSchema,
])

export type PersistedProviderProfile = z.infer<typeof persistedProviderProfileSchema>
export type OpaqueProviderProfile = z.infer<typeof opaqueProviderProfileSchema>

export const providerProfilesDataSchema = z
	.object({
		currentApiConfigName: z.string(),
		apiConfigs: z.record(z.string(), persistedProviderProfileSchema),
		modeApiConfigs: z.record(z.string(), z.string()).optional(),
		cloudProfileIds: z.array(z.string()).optional(),
		migrations: providerProfileMigrationsSchema.optional(),
	})
	.passthrough()

export type ProviderProfilesData = z.infer<typeof providerProfilesDataSchema>

export const providerProfilesEnvelopeSchema = z
	.object({
		schemaVersion: z.literal(PROVIDER_PROFILES_SCHEMA_VERSION),
		data: providerProfilesDataSchema,
	})
	.passthrough()

export type ProviderProfilesEnvelope = z.infer<typeof providerProfilesEnvelopeSchema>

/** Stage 6's flat payload. It is accepted only by the sequential v1 -> v2 migration. */
export const legacyFlatProviderProfileSchema = z.object({ id: z.string().optional() }).passthrough()
export type LegacyFlatProviderProfile = ProviderSettingsWithId & Record<string, unknown>

const legacyProviderProfilesDataSchema = z
	.object({
		currentApiConfigName: z.string(),
		apiConfigs: z.record(z.string(), legacyFlatProviderProfileSchema),
		modeApiConfigs: z.record(z.string(), z.string()).optional(),
		cloudProfileIds: z.array(z.string()).optional(),
		migrations: providerProfileMigrationsSchema.optional(),
	})
	.passthrough()

export type LegacyProviderProfiles = z.infer<typeof legacyProviderProfilesDataSchema>

const providerProfilesEnvelopeHeaderSchema = z
	.object({ schemaVersion: z.number().int().nonnegative(), data: z.unknown() })
	.passthrough()

export class UnsupportedProviderProfilesVersionError extends Error {
	readonly code = "UNSUPPORTED_PROVIDER_PROFILES_VERSION"

	constructor(
		readonly schemaVersion: number,
		readonly supportedSchemaVersion = PROVIDER_PROFILES_SCHEMA_VERSION,
	) {
		super(
			`Provider profile schema version ${schemaVersion} is newer than supported version ${supportedSchemaVersion}`,
		)
		this.name = "UnsupportedProviderProfilesVersionError"
	}
}

type VersionedProviderProfiles = { schemaVersion: number; data: unknown; [key: string]: unknown }
type ProviderProfilesMigration = (envelope: VersionedProviderProfiles) => VersionedProviderProfiles

const sharedFieldNames = [
	"includeMaxTokens",
	"todoListEnabled",
	"enableReasoningEffort",
	"modelTemperature",
	"rateLimitSeconds",
	"consecutiveMistakeLimit",
	"slimToolset",
	"slimHidesMcp",
	"reasoningEffort",
	"modelMaxTokens",
	"modelMaxThinkingTokens",
	"verbosity",
	"codebaseIndexOpenAiCompatibleBaseUrl",
	"codebaseIndexOpenAiCompatibleModelDimension",
] as const satisfies readonly (keyof ProviderSettings)[]

export const providerFieldOwnership = {
	anthropic: ["apiModelId", "anthropicBaseUrl", "anthropicUseAuthToken", "anthropicBeta1MContext"],
	openrouter: ["openRouterModelId", "openRouterBaseUrl", "openRouterSpecificProvider"],
	bedrock: [
		"apiModelId",
		"awsRegion",
		"awsUseCrossRegionInference",
		"awsUseGlobalInference",
		"awsUsePromptCache",
		"awsProfile",
		"awsUseProfile",
		"awsUseApiKey",
		"awsCustomArn",
		"awsModelContextWindow",
		"awsBedrockEndpointEnabled",
		"awsBedrockEndpoint",
		"awsBedrock1MContext",
		"awsBedrockServiceTier",
	],
	vertex: ["apiModelId", "vertexKeyFile", "vertexProjectId", "vertexRegion", "vertex1MContext"],
	openai: [
		"apiModelId",
		"openAiBaseUrl",
		"openAiR1FormatEnabled",
		"openAiModelId",
		"openAiCustomModelInfo",
		"openAiUseAzure",
		"azureApiVersion",
		"openAiStreamingEnabled",
		"openAiHostHeader",
		"openAiHeaders",
	],
	ollama: ["ollamaModelId", "ollamaBaseUrl", "ollamaNumCtx"],
	"vscode-lm": ["vsCodeLmModelSelector"],
	lmstudio: ["lmStudioModelId", "lmStudioBaseUrl", "lmStudioDraftModelId", "lmStudioSpeculativeDecodingEnabled"],
	gemini: ["apiModelId", "googleGeminiBaseUrl"],
	"gemini-cli": ["apiModelId", "geminiCliOAuthPath", "geminiCliProjectId"],
	"openai-codex": ["apiModelId"],
	"openai-native": ["apiModelId", "openAiNativeBaseUrl", "openAiNativeServiceTier"],
	mistral: ["apiModelId", "mistralCodestralUrl"],
	deepseek: ["apiModelId", "deepSeekBaseUrl"],
	poe: ["apiModelId", "poeBaseUrl"],
	moonshot: ["apiModelId", "moonshotBaseUrl"],
	minimax: ["apiModelId", "minimaxBaseUrl"],
	requesty: ["requestyBaseUrl", "requestyModelId"],
	unbound: ["unboundModelId"],
	"fake-ai": ["fakeAi"],
	xai: ["apiModelId"],
	baseten: ["apiModelId"],
	litellm: ["litellmBaseUrl", "litellmModelId", "litellmUsePromptCache"],
	sambanova: ["apiModelId"],
	zai: ["apiModelId", "zaiApiLine"],
	fireworks: ["apiModelId"],
	"qwen-code": ["apiModelId", "qwenCodeOauthPath"],
	"vercel-ai-gateway": ["vercelAiGatewayModelId"],
} satisfies { [K in KnownProviderId]: readonly (keyof ProviderSettings)[] }

const pickPresent = (value: Record<string, unknown>, keys: readonly PropertyKey[]): Record<string, unknown> => {
	const picked: Record<string, unknown> = {}
	for (const key of keys) {
		if (typeof key === "string" && Object.prototype.hasOwnProperty.call(value, key)) {
			picked[key] = value[key]
		}
	}
	return picked
}

/**
 * Strip every SECRET_STATE_KEYS entry from a flat legacy profile so opaque
 * tombstones never carry plaintext secrets to disk. Known-provider configs
 * already lose secrets via `pickPresent(providerFieldOwnership[...])` because
 * the ownership map deliberately excludes secret keys, so this is only
 * required for the opaque branch.
 */
const stripSecretStateKeys = <T extends Record<string, unknown>>(profile: T): T => {
	const stripped = { ...profile }
	for (const key of SECRET_STATE_KEYS) {
		delete stripped[key]
	}
	return stripped
}

export const migrateLegacyFlatProviderProfile = (profile: Record<string, unknown>): PersistedProviderProfile => {
	const providerId = profile.apiProvider
	const classification = classifyProvider(providerId)
	if (classification !== "known-active" && classification !== "known-hidden") {
		return {
			...(typeof profile.id === "string" ? { id: profile.id } : {}),
			provider: {
				providerId: typeof providerId === "string" ? providerId : "unknown",
				opaqueLegacyPayload: structuredClone(stripSecretStateKeys(profile)),
			},
		}
	}

	const knownProviderId = providerId as KnownProviderId
	const shared = pickPresent(profile, sharedFieldNames)
	return {
		...(typeof profile.id === "string" ? { id: profile.id } : {}),
		provider: {
			providerId: knownProviderId,
			config: pickPresent(profile, providerFieldOwnership[knownProviderId]),
		},
		...(Object.keys(shared).length > 0 ? { shared } : {}),
	} as PersistedProviderProfile
}

/**
 * Detect whether a flat (pre-v2) profile carries inline SECRET_STATE_KEYS.
 * Used by {@link ProviderSettingsManager.initialize} to seed
 * `provider_profile_secrets_v2` on first-run migration so legacy API keys are
 * not silently dropped when the v2 envelope rewrites the on-disk store.
 *
 * Returns the matched secret keys (with their values) so the caller can route
 * them straight into `updateProfileSecrets`. Known-provider secrets (e.g.
 * `apiKey`, `openRouterApiKey`) and opaque-profile secrets are both captured
 * because opaque tombstones no longer persist them inline after C3.
 */
export const extractLegacyInlineSecrets = (profile: Record<string, unknown>): Record<string, string> => {
	const secrets: Record<string, string> = {}
	for (const key of SECRET_STATE_KEYS) {
		const value = profile[key]
		if (typeof value === "string" && value.length > 0) {
			secrets[key] = value
		}
	}
	return secrets
}

export const createKnownPersistedProviderProfile = (profile: ProviderSettingsWithId): PersistedProviderProfile => {
	const parsed = providerSettingsSchema.passthrough().parse(profile)
	const classification = classifyProvider(parsed.apiProvider)
	if (classification !== "known-active" && classification !== "known-hidden") {
		throw new Error(
			`Provider '${parsed.apiProvider ?? "unknown"}' is unavailable and cannot be saved as an active profile.`,
		)
	}

	return knownPersistedProviderProfileSchema.parse(migrateLegacyFlatProviderProfile(profile))
}

const migrateLegacyToV1: ProviderProfilesMigration = ({ data, ...envelope }) => ({
	...envelope,
	schemaVersion: 1,
	data: legacyProviderProfilesDataSchema.parse(data),
})

export const migrateProviderProfilesV1ToV2: ProviderProfilesMigration = ({ data, ...envelope }) => {
	const legacy = legacyProviderProfilesDataSchema.parse(data)
	return {
		...envelope,
		schemaVersion: 2,
		data: {
			...legacy,
			apiConfigs: Object.fromEntries(
				Object.entries(legacy.apiConfigs).map(([name, profile]) => [
					name,
					migrateLegacyFlatProviderProfile(profile),
				]),
			),
		},
	}
}

const providerProfilesMigrations: Readonly<Record<number, ProviderProfilesMigration>> = {
	0: migrateLegacyToV1,
	1: migrateProviderProfilesV1ToV2,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const migrateProviderProfiles = (input: unknown): ProviderProfilesEnvelope => {
	const initialEnvelope: VersionedProviderProfiles =
		isRecord(input) && "schemaVersion" in input
			? (providerProfilesEnvelopeHeaderSchema.parse(input) as VersionedProviderProfiles)
			: { schemaVersion: 0, data: legacyProviderProfilesDataSchema.parse(input) }

	if (initialEnvelope.schemaVersion > PROVIDER_PROFILES_SCHEMA_VERSION) {
		throw new UnsupportedProviderProfilesVersionError(initialEnvelope.schemaVersion)
	}

	let migratedEnvelope = structuredClone(initialEnvelope)
	while (migratedEnvelope.schemaVersion < PROVIDER_PROFILES_SCHEMA_VERSION) {
		const migration = providerProfilesMigrations[migratedEnvelope.schemaVersion]
		if (!migration) {
			throw new Error(`Missing provider profile migration for schema version ${migratedEnvelope.schemaVersion}`)
		}
		const nextEnvelope = migration(migratedEnvelope)
		if (nextEnvelope.schemaVersion !== migratedEnvelope.schemaVersion + 1) {
			throw new Error(
				`Provider profile migration ${migratedEnvelope.schemaVersion} must advance exactly one schema version`,
			)
		}
		migratedEnvelope = nextEnvelope
	}

	return providerProfilesEnvelopeSchema.parse(migratedEnvelope)
}

export const createProviderProfilesEnvelope = (data: ProviderProfilesData): ProviderProfilesEnvelope =>
	providerProfilesEnvelopeSchema.parse({ schemaVersion: PROVIDER_PROFILES_SCHEMA_VERSION, data })
