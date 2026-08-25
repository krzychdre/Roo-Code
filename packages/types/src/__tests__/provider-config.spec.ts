import {
	activeProviderIds,
	createKnownPersistedProviderProfile,
	knownProviderConfigurationSchema,
	migrateProviderProfiles,
	migrateProviderProfilesV1ToV2,
	providerConfigSchemas,
	providerFieldOwnership,
	providerProfileToLegacySettings,
	providerProfilesEnvelopeSchema,
} from "../index.js"

// R4: shared fields live in the `shared` section of a persisted profile, not
// in the per-provider `config`, so they are deliberately excluded from
// `providerFieldOwnership[K]`. This list must mirror `sharedFieldNames` in
// provider-profile.ts. The parity test below asserts that every per-provider
// schema field is owned by exactly one entry in `providerFieldOwnership`, so a
// future schema addition forgotten in the ownership map is caught.
const SHARED_FIELD_NAMES = [
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
] as const

describe("provider configuration schemas", () => {
	it("is complete against the active provider registry", () => {
		expect(Object.keys(providerConfigSchemas).sort()).toEqual([...activeProviderIds].sort())
	})

	it.each(activeProviderIds)("accepts a minimal %s configuration", (providerId) => {
		expect(knownProviderConfigurationSchema.safeParse({ providerId, config: {} }).success).toBe(true)
	})

	it("strictly rejects cross-provider fields", () => {
		expect(
			knownProviderConfigurationSchema.safeParse({
				providerId: "anthropic",
				config: { openAiBaseUrl: "https://wrong.example" },
			}).success,
		).toBe(false)
	})

	it("round-trips through the single legacy compatibility boundary", () => {
		const profile = createKnownPersistedProviderProfile({
			apiProvider: "openai",
			openAiBaseUrl: "https://openai.example",
			rateLimitSeconds: 0,
		})
		expect(providerProfileToLegacySettings(profile)).toEqual({
			apiProvider: "openai",
			openAiBaseUrl: "https://openai.example",
			rateLimitSeconds: 0,
		})
	})
})

describe("provider profile v1 -> v2 migration", () => {
	const legacy = {
		schemaVersion: 1,
		data: {
			currentApiConfigName: "known",
			apiConfigs: {
				known: {
					id: "known-id",
					apiProvider: "openai",
					openAiBaseUrl: "",
					openAiStreamingEnabled: false,
					rateLimitSeconds: 0,
					anthropicBaseUrl: "must-not-leak",
				},
				retired: { id: "retired-id", apiProvider: "glama", future: { exact: true } },
				unknown: { id: "unknown-id", apiProvider: "future-provider", zero: 0, empty: "", no: false },
			},
		},
	}

	it("preserves absent/false/zero/empty and isolates provider fields", () => {
		const migrated = migrateProviderProfiles(legacy)
		const known = migrated.data.apiConfigs.known
		expect(known).toEqual({
			id: "known-id",
			provider: {
				providerId: "openai",
				config: { openAiBaseUrl: "", openAiStreamingEnabled: false },
			},
			shared: { rateLimitSeconds: 0 },
		})
		expect(JSON.stringify(known)).not.toContain("anthropicBaseUrl")
	})

	it("preserves retired and unknown payloads exactly and idempotently parses v2", () => {
		const migrated = migrateProviderProfiles(legacy)
		for (const name of ["retired", "unknown"] as const) {
			const original = legacy.data.apiConfigs[name]
			const profile = migrated.data.apiConfigs[name]
			expect(profile).toBeDefined()
			if (!profile) throw new Error(`Missing migrated profile ${name}`)
			expect(profile.provider).toEqual({
				providerId: original.apiProvider,
				opaqueLegacyPayload: original,
			})
		}
		expect(migrateProviderProfiles(migrated)).toEqual(migrated)
		expect(providerProfilesEnvelopeSchema.parse(migrated)).toEqual(migrated)
	})

	it("advances sequentially and rejects future versions", () => {
		const migrated = migrateProviderProfilesV1ToV2(legacy)
		expect(migrated.schemaVersion).toBe(2)
		expect(() => migrateProviderProfiles({ schemaVersion: 99, data: {} })).toThrow("newer than supported")
	})

	it("does not persist plaintext secrets", () => {
		const profile = createKnownPersistedProviderProfile({
			apiProvider: "anthropic",
			apiKey: "plaintext-secret",
			anthropicBaseUrl: "https://api.example",
		})
		expect(JSON.stringify(profile)).not.toContain("plaintext-secret")
	})
})

// R4: schema <-> ownership parity. For every KnownProviderId, the set of keys
// declared in `providerConfigSchemas[K].shape` must equal the set in
// `providerFieldOwnership[K]`, after excluding the shared-field list (which
// lives in the profile's `shared` section, not the per-provider config). This
// catches a future schema field that is forgotten in the ownership map (which
// would cause `pickPresent` to silently drop it during migration) and vice
// versa.
describe("providerConfigSchemas <-> providerFieldOwnership parity", () => {
	it.each([...activeProviderIds])(
		"%s: schema shape keys equal providerFieldOwnership keys (shared fields excluded)",
		(providerId) => {
			const schema = providerConfigSchemas[providerId as keyof typeof providerConfigSchemas]
			const ownership = providerFieldOwnership[providerId as keyof typeof providerFieldOwnership]
			expect(schema).toBeDefined()
			expect(ownership).toBeDefined()
			const schemaKeys = Object.keys(schema.shape).filter((k) => !SHARED_FIELD_NAMES.includes(k as never))
			const ownershipKeys = [...ownership]
			expect(schemaKeys.sort()).toEqual(ownershipKeys.sort())
		},
	)

	it("providerFieldOwnership has no keys for inactive providers that lack a schema", () => {
		const schemaKeys = new Set(Object.keys(providerConfigSchemas))
		const ownershipKeys = new Set(Object.keys(providerFieldOwnership))
		// Every ownership key must have a matching schema (ownership never
		// references a provider without a config schema).
		for (const key of ownershipKeys) {
			expect(schemaKeys.has(key)).toBe(true)
		}
	})
})
