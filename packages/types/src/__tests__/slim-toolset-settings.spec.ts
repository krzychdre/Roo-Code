// npx vitest run packages/types/src/__tests__/slim-toolset-settings.spec.ts

import {
	createKnownPersistedProviderProfile,
	providerProfileToLegacySettings,
	providerSettingsSchema,
} from "../index.js"

describe("slim toolset provider settings", () => {
	it("serializes as absent when unset (never null)", () => {
		const parsed = providerSettingsSchema.parse({ apiProvider: "openai" })

		expect("slimToolset" in parsed).toBe(false)
		expect("slimHidesMcp" in parsed).toBe(false)
		// The self-hosted settings client rejects nulls, so the JSON form must
		// simply omit the keys rather than carry `null`.
		expect(JSON.stringify(parsed)).not.toContain("slimToolset")
		expect(JSON.stringify(parsed)).not.toContain("null")
	})

	it("rejects a null value rather than coercing it", () => {
		expect(providerSettingsSchema.safeParse({ apiProvider: "openai", slimToolset: null }).success).toBe(false)
		expect(providerSettingsSchema.safeParse({ apiProvider: "openai", slimHidesMcp: null }).success).toBe(false)
	})

	it("accepts both booleans and keeps false as false", () => {
		const parsed = providerSettingsSchema.parse({
			apiProvider: "openai",
			slimToolset: true,
			slimHidesMcp: false,
		})

		expect(parsed.slimToolset).toBe(true)
		expect(parsed.slimHidesMcp).toBe(false)
	})

	it("round-trips through the persisted profile payload the editor saves", () => {
		// The profile editor sends a flat ProviderSettings object; it is stored
		// as a structured profile (slim flags belong to the shared section, they
		// are not provider-specific) and read back flat.
		const profile = createKnownPersistedProviderProfile({
			apiProvider: "openai",
			openAiBaseUrl: "https://local.example/v1",
			slimToolset: true,
			slimHidesMcp: false,
		})

		expect("config" in profile.provider ? profile.provider.config : {}).not.toHaveProperty("slimToolset")
		expect("shared" in profile ? profile.shared : undefined).toMatchObject({
			slimToolset: true,
			slimHidesMcp: false,
		})
		expect(providerProfileToLegacySettings(profile)).toEqual({
			apiProvider: "openai",
			openAiBaseUrl: "https://local.example/v1",
			slimToolset: true,
			slimHidesMcp: false,
		})
	})

	it("keeps an unset flag out of the persisted profile entirely", () => {
		const profile = createKnownPersistedProviderProfile({
			apiProvider: "openai",
			slimToolset: true,
		})

		expect("shared" in profile ? profile.shared : undefined).toEqual({ slimToolset: true })
		expect(JSON.stringify(profile)).not.toContain("slimHidesMcp")
	})
})
