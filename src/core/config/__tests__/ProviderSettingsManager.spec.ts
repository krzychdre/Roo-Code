// npx vitest src/core/config/__tests__/ProviderSettingsManager.spec.ts

import { ExtensionContext } from "vscode"

import type { ProviderSettings } from "@roo-code/types"

import { ProviderSettingsManager, ProviderProfiles, SyncCloudProfilesResult } from "../ProviderSettingsManager"

// Mock VSCode ExtensionContext
const mockSecrets = {
	get: vi.fn(),
	store: vi.fn(),
	delete: vi.fn(),
}

const unwrapStoredProfiles = (value: string): any => {
	const parsed = JSON.parse(value)
	const data = "schemaVersion" in parsed ? parsed.data : parsed
	return {
		...data,
		apiConfigs: Object.fromEntries(
			Object.entries(data.apiConfigs).map(([name, profile]: [string, any]) => [
				name,
				profile.provider
					? "config" in profile.provider
						? {
								id: profile.id,
								apiProvider: profile.provider.providerId,
								...profile.shared,
								...profile.provider.config,
							}
						: profile.provider.opaqueLegacyPayload
					: profile,
			]),
		),
	}
}

/**
 * Inspect mockSecrets.store calls for the `provider_profile_secrets_v2` write
 * and return the parsed secret map (profileId -> secret key -> value). Used to
 * assert that first-run migration seeds secrets into the v2 secret store
 * instead of dropping them (C1) and that opaque profiles route their secrets
 * here too (C3).
 */
const unwrapStoredProfileSecrets = (): Record<string, Record<string, unknown>> => {
	// `updateProfileSecrets` merges into the existing map and re-stores the
	// whole map on every call, so the LAST v2-secrets write is the cumulative
	// state. Use the last matching call, not the first.
	const calls = mockSecrets.store.mock.calls.filter(
		(args) => args[0] === "roo_cline_config_provider_profile_secrets_v2",
	)
	const call = calls[calls.length - 1]
	if (!call) return {}
	try {
		const parsed = JSON.parse(call[1] as string)
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, Record<string, unknown>>)
			: {}
	} catch {
		return {}
	}
}

/**
 * Wire `mockSecrets` to a key-aware in-memory map so tests that assert on
 * secret round-tripping can verify `provider_profile_secrets_v2` is actually
 * consulted by `loadProfileSecrets()` (rather than the legacy config key
 * returning the same value for every key, which masked C1/C3 regressions).
 *
 * Pass the initial envelope JSON to seed the `api_config` key. Returns the
 * underlying map so the test can assert on it directly.
 */
const setupKeyAwareSecrets = (initialApiConfigJson?: string): Record<string, string> => {
	const store: Record<string, string> = {}
	if (initialApiConfigJson !== undefined) {
		store["roo_cline_config_api_config"] = initialApiConfigJson
	}
	mockSecrets.get.mockImplementation(async (key: string) => (key in store ? store[key] : undefined))
	mockSecrets.store.mockImplementation(async (key: string, value: string) => {
		store[key] = value
	})
	mockSecrets.delete.mockImplementation(async (key: string) => {
		delete store[key]
	})
	return store
}

const mockGlobalState = {
	get: vi.fn(),
	update: vi.fn(),
}

const mockContext = {
	secrets: mockSecrets,
	globalState: mockGlobalState,
} as unknown as ExtensionContext

describe("ProviderSettingsManager", () => {
	let providerSettingsManager: ProviderSettingsManager

	beforeEach(() => {
		vi.clearAllMocks()
		// Reset all mock implementations to default successful behavior
		mockSecrets.get.mockResolvedValue(null)
		mockSecrets.store.mockResolvedValue(undefined)
		mockSecrets.delete.mockResolvedValue(undefined)
		mockGlobalState.get.mockReturnValue(undefined)
		mockGlobalState.update.mockResolvedValue(undefined)

		providerSettingsManager = new ProviderSettingsManager(mockContext)
	})

	describe("initialize", () => {
		it("should not write to storage when secrets.get returns null", async () => {
			// Mock readConfig to return null
			mockSecrets.get.mockResolvedValueOnce(null)

			await providerSettingsManager.initialize()

			// Should not write to storage because readConfig returns defaultConfig
			expect(mockSecrets.store).not.toHaveBeenCalled()
		})

		it("upgrades legacy profiles to the versioned envelope and preserves unknown provider fields", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "future",
					apiConfigs: {
						future: {
							id: "future-id",
							apiProvider: "future-provider",
							futureSecret: "preserve-me",
							futureSettings: { nested: true },
						},
					},
				}),
			)

			await providerSettingsManager.initialize()

			const storedEnvelope = JSON.parse(mockSecrets.store.mock.calls.at(-1)?.[1] as string)
			expect(storedEnvelope.schemaVersion).toBe(2)
			expect(storedEnvelope.data.apiConfigs.future.provider).toMatchObject({
				providerId: "future-provider",
				opaqueLegacyPayload: {
					apiProvider: "future-provider",
					futureSecret: "preserve-me",
					futureSettings: { nested: true },
				},
			})
		})

		it("should upgrade an unversioned config even when legacy migrations are complete", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
						},
					},
					modeApiConfigs: {},
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
						consecutiveMistakeLimitMigrated: true,
						todoListEnabledMigrated: true,
						claudeCodeLegacySettingsMigrated: true,
					},
				}),
			)

			await providerSettingsManager.initialize()

			expect(mockSecrets.store).toHaveBeenCalledOnce()
			expect(JSON.parse(mockSecrets.store.mock.calls[0][1]).schemaVersion).toBe(2)
		})

		it("should generate IDs for configs that lack them", async () => {
			// Mock a config with missing IDs
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
						},
						test: {
							apiProvider: "anthropic",
						},
					},
					migrations: {
						rateLimitSecondsMigrated: true,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Should have written the config with new IDs
			expect(mockSecrets.store).toHaveBeenCalled()
			const calls = mockSecrets.store.mock.calls
			const persistedCall = [...calls].reverse().find((call) => {
				try {
					const parsed = JSON.parse(String(call[1]))
					return parsed.schemaVersion === 2 && parsed.data?.apiConfigs?.default?.id
				} catch {
					return false
				}
			})
			const storedEnvelope = JSON.parse(persistedCall![1])
			expect(storedEnvelope.data.apiConfigs.default.id).toBeTruthy()
			expect(storedEnvelope.data.apiConfigs.test.id).toBeTruthy()
		})

		it("should call migrateRateLimitSeconds if it has not done so already", async () => {
			mockGlobalState.get.mockResolvedValue(42)

			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
							rateLimitSeconds: undefined,
						},
						test: {
							apiProvider: "anthropic",
							rateLimitSeconds: undefined,
						},
						existing: {
							apiProvider: "anthropic",
							// this should not really be possible, unless someone has loaded a hand edited config,
							// but we don't overwrite so we'll check that
							rateLimitSeconds: 43,
						},
					},
					migrations: {
						rateLimitSecondsMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Get the last call to store, which should contain the migrated config
			const calls = mockSecrets.store.mock.calls
			const storedConfig = unwrapStoredProfiles(calls[calls.length - 1][1])
			expect(storedConfig.apiConfigs.default.rateLimitSeconds).toEqual(42)
			expect(storedConfig.apiConfigs.test.rateLimitSeconds).toEqual(42)
			expect(storedConfig.apiConfigs.existing.rateLimitSeconds).toEqual(43)
		})

		it("should call migrateConsecutiveMistakeLimit if it has not done so already", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
							consecutiveMistakeLimit: undefined,
						},
						test: {
							apiProvider: "anthropic",
							consecutiveMistakeLimit: undefined,
						},
						existing: {
							apiProvider: "anthropic",
							// this should not really be possible, unless someone has loaded a hand edited config,
							// but we don't overwrite so we'll check that
							consecutiveMistakeLimit: 5,
						},
					},
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
						consecutiveMistakeLimitMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Get the last call to store, which should contain the migrated config
			const calls = mockSecrets.store.mock.calls
			const storedConfig = unwrapStoredProfiles(calls[calls.length - 1][1])
			expect(storedConfig.apiConfigs.default.consecutiveMistakeLimit).toEqual(3)
			expect(storedConfig.apiConfigs.test.consecutiveMistakeLimit).toEqual(3)
			expect(storedConfig.apiConfigs.existing.consecutiveMistakeLimit).toEqual(5)
			expect(storedConfig.migrations.consecutiveMistakeLimitMigrated).toEqual(true)
		})

		it("should call migrateTodoListEnabled if it has not done so already", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
							todoListEnabled: undefined,
						},
						test: {
							apiProvider: "anthropic",
							todoListEnabled: undefined,
						},
						existing: {
							apiProvider: "anthropic",
							// this should not really be possible, unless someone has loaded a hand edited config,
							// but we don't overwrite so we'll check that
							todoListEnabled: false,
						},
					},
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
						consecutiveMistakeLimitMigrated: true,
						todoListEnabledMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Get the last call to store, which should contain the migrated config
			const calls = mockSecrets.store.mock.calls
			const storedConfig = unwrapStoredProfiles(calls[calls.length - 1][1])
			expect(storedConfig.apiConfigs.default.todoListEnabled).toEqual(true)
			expect(storedConfig.apiConfigs.test.todoListEnabled).toEqual(true)
			expect(storedConfig.apiConfigs.existing.todoListEnabled).toEqual(false)
			expect(storedConfig.migrations.todoListEnabledMigrated).toEqual(true)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.initialize()).rejects.toThrow(
				"Failed to initialize config: Error: Failed to read provider profiles from secrets: Error: Storage failed",
			)
		})
	})

	describe("ListConfig", () => {
		it("should list all available configs", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {
						id: "default",
					},
					test: {
						apiProvider: "anthropic",
						id: "test-id",
					},
				},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const configs = await providerSettingsManager.listConfig()
			expect(configs).toEqual([
				{ name: "default", id: "default", apiProvider: undefined },
				{ name: "test", id: "test-id", apiProvider: "anthropic" },
			])
		})

		it("should handle empty config file", async () => {
			const emptyConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(emptyConfig))

			const configs = await providerSettingsManager.listConfig()
			expect(configs).toEqual([])
		})

		it("should throw error if reading from secrets fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Read failed"))

			await expect(providerSettingsManager.listConfig()).rejects.toThrow(
				"Failed to list configs: Error: Failed to read provider profiles from secrets: Error: Read failed",
			)
		})
	})

	describe("SaveConfig", () => {
		it("should save new config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {},
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			const newConfig: ProviderSettings = {
				apiProvider: "vertex",
				apiModelId: "gemini-2.5-flash-preview-05-20",
				vertexKeyFile: "test-key-file",
			}

			await providerSettingsManager.saveConfig("test", newConfig)

			// Get the actual stored config to check the generated ID
			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			const testConfigId = storedConfig.apiConfigs.test.id

			const expectedConfig = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {},
					test: {
						...newConfig,
						id: testConfigId,
					},
				},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
			}

			expect(mockSecrets.store.mock.calls[0][0]).toEqual("roo_cline_config_api_config")
			expect(storedConfig).toEqual(expectedConfig)
		})

		it("should only save provider relevant settings", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {},
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			const newConfig: ProviderSettings = {
				apiProvider: "anthropic",
				apiKey: "test-key",
			}
			const newConfigWithExtra: ProviderSettings = {
				...newConfig,
				openRouterApiKey: "another-key",
			}

			await providerSettingsManager.saveConfig("test", newConfigWithExtra)

			// Get the actual stored config to check the generated ID
			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			const testConfigId = storedConfig.apiConfigs.test.id

			const expectedConfig = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {},
					test: {
						apiProvider: "anthropic",
						id: testConfigId,
					},
				},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
			}

			expect(mockSecrets.store.mock.calls[0][0]).toEqual("roo_cline_config_api_config")
			expect(storedConfig).toEqual(expectedConfig)
		})

		it("should update existing config", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					test: {
						apiProvider: "anthropic",
						apiKey: "old-key",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const updatedConfig: ProviderSettings = {
				apiProvider: "anthropic",
				apiKey: "new-key",
			}

			await providerSettingsManager.saveConfig("test", updatedConfig)

			const expectedConfig = {
				currentApiConfigName: "default",
				apiConfigs: {
					test: {
						apiProvider: "anthropic",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(mockSecrets.store.mock.calls[0][0]).toEqual("roo_cline_config_api_config")
			expect(storedConfig).toEqual(expectedConfig)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: {} },
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
					},
				}),
			)
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.saveConfig("test", {})).rejects.toThrow(
				"Failed to save config: Error: Failed to write provider profiles to secrets: Error: Storage failed",
			)
		})

		it("should preserve full fields including legacy provider-specific keys when saving retired provider profiles", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {},
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			// Include a legacy provider-specific field (groqApiKey) that is no
			// longer in the schema — passthrough() must keep it.
			const retiredConfig = {
				apiProvider: "groq",
				apiKey: "legacy-key",
				apiModelId: "legacy-model",
				openAiBaseUrl: "https://legacy.example/v1",
				openAiApiKey: "legacy-openai-key",
				modelMaxTokens: 4096,
				groqApiKey: "legacy-groq-specific-key",
			} as ProviderSettings

			await providerSettingsManager.saveConfig("retired", retiredConfig)

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs.retired.apiProvider).toBe("groq")
			expect(storedConfig.apiConfigs.retired.apiKey).toBeUndefined()
			expect(storedConfig.apiConfigs.retired.apiModelId).toBe("legacy-model")
			expect(storedConfig.apiConfigs.retired.openAiBaseUrl).toBe("https://legacy.example/v1")
			expect(storedConfig.apiConfigs.retired.openAiApiKey).toBeUndefined()
			expect(storedConfig.apiConfigs.retired.modelMaxTokens).toBe(4096)
			// Verify legacy provider-specific field is preserved via passthrough
			expect(storedConfig.apiConfigs.retired.groqApiKey).toBe("legacy-groq-specific-key")
			expect(mockSecrets.store.mock.calls[0][1]).toContain('"id"')
		})
	})

	describe("DeleteConfig", () => {
		it("should delete existing config", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {
						id: "default",
					},
					test: {
						apiProvider: "anthropic",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			await providerSettingsManager.deleteConfig("test")

			// Get the stored config to check the ID
			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.currentApiConfigName).toBe("default")
			expect(Object.keys(storedConfig.apiConfigs)).toEqual(["default"])
			expect(storedConfig.apiConfigs.default.id).toBeTruthy()
		})

		it("should throw error when trying to delete non-existent config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: {} },
				}),
			)

			await expect(providerSettingsManager.deleteConfig("nonexistent")).rejects.toThrow(
				"Config 'nonexistent' not found",
			)
		})

		it("should throw error when trying to delete last remaining config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							id: "default",
						},
					},
				}),
			)

			await expect(providerSettingsManager.deleteConfig("default")).rejects.toThrow(
				"Failed to delete config: Error: Cannot delete the last remaining configuration",
			)
		})
	})

	describe("LoadConfig", () => {
		it("should load config and update current config name", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					test: {
						apiProvider: "anthropic",
						apiKey: "test-key",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: true,
					openAiHeadersMigrated: true,
					consecutiveMistakeLimitMigrated: true,
					todoListEnabledMigrated: true,
					claudeCodeLegacySettingsMigrated: true,
				},
			}

			mockGlobalState.get.mockResolvedValue(42)
			// Use a key-aware in-memory secret store so `loadProfileSecrets()`
			// reads from `provider_profile_secrets_v2` rather than the legacy
			// `api_config` key (which would otherwise return the same value
			// for every key and mask the C1 regression).
			const secretsStore = setupKeyAwareSecrets(JSON.stringify(existingConfig))
			// Re-instantiate so the constructor's auto-initialize runs against
			// the key-aware store instead of the `beforeEach` default (null),
			// which would otherwise race ahead and store the default envelope.
			providerSettingsManager = new ProviderSettingsManager(mockContext)
			// First-run migration must seed `provider_profile_secrets_v2` from
			// the legacy inline `apiKey` so the secret survives the v2 rewrite
			// (C1). Previously this test asserted the secret was LOST, which
			// encoded the data-loss regression as intended behavior.
			await providerSettingsManager.initialize()

			const profileSecrets = unwrapStoredProfileSecrets()
			expect(profileSecrets["test-id"]).toBeDefined()
			expect(profileSecrets["test-id"].apiKey).toBe("test-key")
			// Sanity: the in-memory store actually has the v2 secrets key.
			expect(secretsStore["roo_cline_config_provider_profile_secrets_v2"]).toBeDefined()

			const { name, ...providerSettings } = await providerSettingsManager.activateProfile({ name: "test" })

			expect(name).toBe("test")
			// The secret must round-trip back through getProfile/activateProfile.
			expect(providerSettings.apiKey).toBe("test-key")
			expect(providerSettings.apiProvider).toBe("anthropic")
			expect(providerSettings.id).toBe("test-id")

			// Get the stored config to check the structure.
			const calls = mockSecrets.store.mock.calls
			const storedConfig = unwrapStoredProfiles(calls[calls.length - 1][1])
			expect(storedConfig.currentApiConfigName).toBe("test")

			expect(storedConfig.apiConfigs.test).toEqual({
				id: "test-id",
				apiProvider: "anthropic",
			})
			// Plaintext secret must NOT appear in the on-disk v2 envelope.
			expect(JSON.stringify(storedConfig)).not.toContain("test-key")
		})

		it("should throw error when config does not exist", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { config: {}, id: "default" } },
				}),
			)

			await expect(providerSettingsManager.activateProfile({ name: "nonexistent" })).rejects.toThrow(
				"Config with name 'nonexistent' not found",
			)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { test: { apiProvider: "anthropic", id: "test-id" } },
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
					},
				}),
			)
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.activateProfile({ name: "test" })).rejects.toThrow(
				"Failed to activate profile: Failed to write provider profiles to secrets: Error: Storage failed",
			)
		})

		it("should preserve unknown providers as opaque tombstones", async () => {
			const configWithUnknownProvider = {
				currentApiConfigName: "valid",
				apiConfigs: {
					valid: {
						apiProvider: "anthropic",
						apiKey: "valid-key",
						apiModelId: "claude-3-opus-20240229",
						id: "valid-id",
					},
					unknownProvider: {
						// Provider value that is neither active nor retired.
						id: "removed-id",
						apiProvider: "invalid-removed-provider",
						apiKey: "some-key",
						apiModelId: "some-model",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: true,
					openAiHeadersMigrated: true,
					consecutiveMistakeLimitMigrated: true,
					todoListEnabledMigrated: true,
				},
			}

			// Key-aware store so the secret round-trip is observable.
			setupKeyAwareSecrets(JSON.stringify(configWithUnknownProvider))
			// Re-instantiate so the constructor's auto-initialize runs against
			// the key-aware store instead of the `beforeEach` default (null).
			providerSettingsManager = new ProviderSettingsManager(mockContext)

			await providerSettingsManager.initialize()

			const storeCalls = mockSecrets.store.mock.calls
			expect(storeCalls.length).toBeGreaterThan(0)
			const finalStoredConfigJson = storeCalls[storeCalls.length - 1][1]

			const storedConfig = unwrapStoredProfiles(finalStoredConfigJson)
			// The valid provider should be untouched
			expect(storedConfig.apiConfigs.valid).toBeDefined()
			expect(storedConfig.apiConfigs.valid.apiProvider).toBe("anthropic")

			// Unknown-provider data must remain lossless for a newer client.
			expect(storedConfig.apiConfigs.unknownProvider).toBeDefined()
			expect(storedConfig.apiConfigs.unknownProvider.apiProvider).toBe("invalid-removed-provider")
			expect(storedConfig.apiConfigs.unknownProvider.id).toBe("removed-id")

			// C3: opaque retired/unknown profiles must NOT carry plaintext
			// SECRET_STATE_KEYS in the persisted envelope; the secret is routed
			// to `provider_profile_secrets_v2` instead.
			expect(storedConfig.apiConfigs.unknownProvider.apiKey).toBeUndefined()
			expect(finalStoredConfigJson).not.toContain("some-key")
			const profileSecrets = unwrapStoredProfileSecrets()
			expect(profileSecrets["removed-id"]).toBeDefined()
			expect(profileSecrets["removed-id"].apiKey).toBe("some-key")
			// The known profile's apiKey is also seeded into the secret store.
			expect(profileSecrets["valid-id"]).toBeDefined()
			expect(profileSecrets["valid-id"].apiKey).toBe("valid-key")
		})

		it("should preserve retired providers and their fields including legacy provider-specific keys during initialize", async () => {
			const configWithRetiredProvider = {
				currentApiConfigName: "retiredProvider",
				apiConfigs: {
					retiredProvider: {
						id: "retired-id",
						apiProvider: "groq",
						apiKey: "legacy-key",
						apiModelId: "legacy-model",
						openAiBaseUrl: "https://legacy.example/v1",
						modelMaxTokens: 1024,
						// Legacy provider-specific field no longer in schema
						groqApiKey: "legacy-groq-key",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
					openAiHeadersMigrated: true,
					consecutiveMistakeLimitMigrated: true,
					todoListEnabledMigrated: true,
					claudeCodeLegacySettingsMigrated: true,
				},
			}

			mockGlobalState.get.mockResolvedValue(0)
			// Key-aware store so the opaque profile's secret round-trips
			// through `provider_profile_secrets_v2` (C3).
			setupKeyAwareSecrets(JSON.stringify(configWithRetiredProvider))
			// Re-instantiate so the constructor's auto-initialize runs against
			// the key-aware store instead of the `beforeEach` default (null).
			providerSettingsManager = new ProviderSettingsManager(mockContext)

			await providerSettingsManager.initialize()

			const storeCalls = mockSecrets.store.mock.calls
			expect(storeCalls.length).toBeGreaterThan(0)
			const finalStoredConfigJson = storeCalls[storeCalls.length - 1][1]
			const storedConfig = unwrapStoredProfiles(finalStoredConfigJson)

			expect(storedConfig.apiConfigs.retiredProvider).toBeDefined()
			expect(storedConfig.apiConfigs.retiredProvider.apiProvider).toBe("groq")
			// C3: the inline `apiKey` (a SECRET_STATE_KEY) is stripped from the
			// opaque payload and routed to `provider_profile_secrets_v2`.
			expect(storedConfig.apiConfigs.retiredProvider.apiKey).toBeUndefined()
			expect(storedConfig.apiConfigs.retiredProvider.apiModelId).toBe("legacy-model")
			expect(storedConfig.apiConfigs.retiredProvider.openAiBaseUrl).toBe("https://legacy.example/v1")
			expect(storedConfig.apiConfigs.retiredProvider.modelMaxTokens).toBe(1024)
			// Verify legacy provider-specific field is preserved via passthrough.
			// `groqApiKey` is NOT a SECRET_STATE_KEY so it stays in the payload.
			expect(storedConfig.apiConfigs.retiredProvider.groqApiKey).toBe("legacy-groq-key")
			// The secret must round-trip back through getProfile/activateProfile.
			const { name: _name, ...reloaded } = await providerSettingsManager.getProfile({ name: "retiredProvider" })
			expect(reloaded.apiKey).toBe("legacy-key")
			expect((reloaded as Record<string, unknown>).groqApiKey).toBe("legacy-groq-key")
			// Plaintext secret must NOT leak to disk via the v2 envelope.
			expect(finalStoredConfigJson).not.toContain("legacy-key")
		})

		it("should preserve unknown object profiles and reject malformed non-object profiles", async () => {
			const invalidConfig = {
				currentApiConfigName: "valid",
				apiConfigs: {
					valid: {
						apiProvider: "anthropic",
						apiKey: "valid-key",
						apiModelId: "claude-3-opus-20240229",
						rateLimitSeconds: 0,
					},
					invalidProvider: {
						// Invalid API provider - should be sanitized (kept but apiProvider reset to undefined)
						id: "x.ai",
						apiProvider: "x.ai",
					},
					// Incorrect type - should be completely removed
					anotherInvalid: "not an object",
				},
				migrations: {
					rateLimitSecondsMigrated: true,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(invalidConfig))

			await expect(providerSettingsManager.initialize()).rejects.toThrow()
			expect(mockSecrets.store).not.toHaveBeenCalled()
		})
	})

	describe("Export", () => {
		it("should preserve retired provider profiles with full fields", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "retired",
				apiConfigs: {
					retired: {
						id: "retired-id",
						apiProvider: "groq",
						apiKey: "legacy-key",
						apiModelId: "legacy-model",
						openAiBaseUrl: "https://legacy.example/v1",
						modelMaxTokens: 4096,
						modelMaxThinkingTokens: 2048,
					},
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const exported = await providerSettingsManager.export()
			const retired = exported.apiConfigs.retired
			expect(retired && "provider" in retired ? retired.provider : undefined).toMatchObject({
				providerId: "groq",
				opaqueLegacyPayload: expect.objectContaining({
					apiProvider: "groq",
					apiModelId: "legacy-model",
					openAiBaseUrl: "https://legacy.example/v1",
					modelMaxTokens: 4096,
					modelMaxThinkingTokens: 2048,
				}),
			})
			// C3: opaque retired/unknown profiles must NOT carry plaintext
			// SECRET_STATE_KEYS in the exported envelope. The apiKey is stripped
			// by the migration path so export files never leak secrets to disk.
			const opaquePayload =
				retired && "provider" in retired && "opaqueLegacyPayload" in retired.provider
					? (retired.provider.opaqueLegacyPayload as Record<string, unknown>)
					: undefined
			expect(opaquePayload?.apiKey).toBeUndefined()
			expect(JSON.stringify(exported)).not.toContain("legacy-key")
		})

		it("should preserve modelMaxTokens for models that support a configurable max output (e.g. GLM)", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "glm",
				apiConfigs: {
					glm: {
						id: "glm-id",
						apiProvider: "zai",
						apiModelId: "glm-5.1",
						modelMaxTokens: 8192,
						modelMaxThinkingTokens: 2048,
					},
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const exported = await providerSettingsManager.export()

			// GLM exposes a configurable max output (supportsMaxTokens) but no reasoning budget,
			// so modelMaxTokens must survive the export while modelMaxThinkingTokens is dropped.
			const glm = exported.apiConfigs.glm
			expect(glm && "shared" in glm ? glm.shared?.modelMaxTokens : undefined).toBe(8192)
			expect(glm && "shared" in glm ? glm.shared?.modelMaxThinkingTokens : undefined).toBeUndefined()
		})

		it("should strip both token fields for models that support neither reasoning budgets nor a configurable max", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "anthropic",
				apiConfigs: {
					anthropic: {
						id: "anthropic-id",
						apiProvider: "anthropic",
						apiModelId: "claude-3-5-haiku-20241022",
						modelMaxTokens: 8192,
						modelMaxThinkingTokens: 2048,
					},
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const exported = await providerSettingsManager.export()
			const anthropic = exported.apiConfigs.anthropic
			expect(anthropic && "shared" in anthropic ? anthropic.shared?.modelMaxTokens : undefined).toBeUndefined()
			expect(
				anthropic && "shared" in anthropic ? anthropic.shared?.modelMaxThinkingTokens : undefined,
			).toBeUndefined()
		})
	})

	describe("ResetAllConfigs", () => {
		it("should delete all stored configs", async () => {
			// Setup initial config
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "test",
					apiConfigs: { test: { apiProvider: "anthropic", id: "test-id" } },
				}),
			)

			await providerSettingsManager.resetAllConfigs()

			// Should have called delete with the correct config key
			expect(mockSecrets.delete).toHaveBeenCalledWith("roo_cline_config_api_config")
		})
	})

	describe("HasConfig", () => {
		it("should return true for existing config", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { id: "default" }, test: { apiProvider: "anthropic", id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const hasConfig = await providerSettingsManager.hasConfig("test")
			expect(hasConfig).toBe(true)
		})

		it("should return false for non-existent config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({ currentApiConfigName: "default", apiConfigs: { default: {} } }),
			)

			const hasConfig = await providerSettingsManager.hasConfig("nonexistent")
			expect(hasConfig).toBe(false)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.hasConfig("test")).rejects.toThrow(
				"Failed to check config existence: Error: Failed to read provider profiles from secrets: Error: Storage failed",
			)
		})
	})

	describe("setModeConfigs", () => {
		it("should assign the given config id to every listed mode in a single store call", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: { id: "default" },
						local: { apiProvider: "ollama", id: "local-id" },
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			await providerSettingsManager.setModeConfigs(["code", "architect", "ask"], "local-id")

			// A bulk assignment must persist with exactly one store round-trip.
			expect(mockSecrets.store).toHaveBeenCalledTimes(1)

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.modeApiConfigs).toEqual({
				code: "local-id",
				architect: "local-id",
				ask: "local-id",
			})
		})

		it("should preserve assignments for modes not included in the list", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: { id: "default" },
						local: { apiProvider: "ollama", id: "local-id" },
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			await providerSettingsManager.setModeConfigs(["code"], "local-id")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.modeApiConfigs).toEqual({
				code: "local-id",
				architect: "default",
				ask: "default",
			})
		})

		it("should create the modeApiConfigs map when it is absent", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" }, local: { apiProvider: "ollama", id: "local-id" } },
				}),
			)

			await providerSettingsManager.setModeConfigs(["code", "ask"], "local-id")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.modeApiConfigs).toMatchObject({
				code: "local-id",
				ask: "local-id",
			})
		})

		it("should not write when given an empty mode list", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
					modeApiConfigs: { code: "default" },
				}),
			)

			await providerSettingsManager.setModeConfigs([], "default")

			expect(mockSecrets.store).not.toHaveBeenCalled()
		})
	})

	describe("syncCloudProfiles", () => {
		it("should add new cloud profiles without secret keys", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
				},
				cloudProfileIds: [],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"cloud-profile": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
					apiKey: "secret-key", // This should be removed
					apiModelId: "claude-3-opus-20240229",
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["cloud-profile"]).toEqual({
				id: "cloud-id-1",
				apiProvider: "anthropic",
				apiModelId: "claude-3-opus-20240229",
				// apiKey should be removed
			})
			expect(storedConfig.cloudProfileIds).toEqual(["cloud-id-1"])
		})

		it("should update existing cloud profiles by ID, preserving secret keys", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
					"existing-cloud": {
						id: "cloud-id-1",
						apiProvider: "anthropic" as const,
						apiKey: "existing-secret",
						apiModelId: "claude-3-haiku-20240307",
					},
				},
				cloudProfileIds: ["cloud-id-1"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"updated-name": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
					apiKey: "new-secret", // Should be ignored
					apiModelId: "claude-3-opus-20240229",
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["updated-name"]).toEqual({
				id: "cloud-id-1",
				apiProvider: "anthropic",
				apiModelId: "claude-3-opus-20240229", // Updated
			})
			expect(JSON.stringify(storedConfig)).not.toContain("existing-secret")
			expect(storedConfig.apiConfigs["existing-cloud"]).toBeUndefined()
			expect(storedConfig.cloudProfileIds).toEqual(["cloud-id-1"])
		})

		it("should delete cloud profiles not in the new cloud profiles", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
					"cloud-profile-1": { id: "cloud-id-1", apiProvider: "anthropic" as const },
					"cloud-profile-2": { id: "cloud-id-2", apiProvider: "openai" as const },
				},
				cloudProfileIds: ["cloud-id-1", "cloud-id-2"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"cloud-profile-1": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
				},
				// cloud-profile-2 is missing, should be deleted
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["cloud-profile-1"]).toBeDefined()
			expect(storedConfig.apiConfigs["cloud-profile-2"]).toBeUndefined()
			expect(storedConfig.cloudProfileIds).toEqual(["cloud-id-1"])
		})

		it("should rename existing non-cloud profile when cloud profile has same name", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
					"conflict-name": { id: "local-id", apiProvider: "openai" as const },
				},
				cloudProfileIds: [],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"conflict-name": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["conflict-name"]).toEqual({
				id: "cloud-id-1",
				apiProvider: "anthropic",
			})
			expect(storedConfig.apiConfigs["conflict-name_local"]).toEqual({
				id: "local-id",
				apiProvider: "openai",
			})
			expect(storedConfig.cloudProfileIds).toEqual(["cloud-id-1"])
		})

		it("should handle multiple naming conflicts with incremental suffixes", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
					"conflict-name": { id: "local-id-1", apiProvider: "openai" as const },
					"conflict-name_local": { id: "local-id-2", apiProvider: "vertex" as const },
				},
				cloudProfileIds: [],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"conflict-name": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["conflict-name"]).toEqual({
				id: "cloud-id-1",
				apiProvider: "anthropic",
			})
			expect(storedConfig.apiConfigs["conflict-name_1"]).toEqual({
				id: "local-id-1",
				apiProvider: "openai",
			})
			expect(storedConfig.apiConfigs["conflict-name_local"]).toEqual({
				id: "local-id-2",
				apiProvider: "vertex",
			})
		})

		it("should handle empty cloud profiles by deleting all cloud-managed profiles", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
					"cloud-profile-1": { id: "cloud-id-1", apiProvider: "anthropic" as const },
					"cloud-profile-2": { id: "cloud-id-2", apiProvider: "openai" as const },
				},
				cloudProfileIds: ["cloud-id-1", "cloud-id-2"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["cloud-profile-1"]).toBeUndefined()
			expect(storedConfig.apiConfigs["cloud-profile-2"]).toBeUndefined()
			expect(storedConfig.apiConfigs["default"]).toBeDefined()
			expect(storedConfig.cloudProfileIds).toEqual([])
		})

		it("should skip cloud profiles without IDs", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
				},
				cloudProfileIds: [],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"valid-profile": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
				},
				"invalid-profile": {
					// Missing id
					apiProvider: "openai" as const,
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["valid-profile"]).toBeDefined()
			expect(storedConfig.apiConfigs["invalid-profile"]).toBeUndefined()
			expect(storedConfig.cloudProfileIds).toEqual(["cloud-id-1"])
		})

		it("should handle complex sync scenario with multiple operations", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: { id: "default-id" },
					"keep-cloud": { id: "cloud-id-1", apiProvider: "anthropic" as const, apiKey: "secret1" },
					"delete-cloud": { id: "cloud-id-2", apiProvider: "openai" as const },
					"rename-me": { id: "local-id", apiProvider: "vertex" as const },
				},
				cloudProfileIds: ["cloud-id-1", "cloud-id-2"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"updated-keep": {
					id: "cloud-id-1",
					apiProvider: "anthropic" as const,
					apiKey: "new-secret", // Should be ignored
					apiModelId: "claude-3-opus-20240229",
				},
				"rename-me": {
					id: "cloud-id-3",
					apiProvider: "openai" as const,
				},
				// delete-cloud is missing (should be deleted)
				// new profile
				"new-cloud": {
					id: "cloud-id-4",
					apiProvider: "vertex" as const,
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles)

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("")

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])

			// Check deletions
			expect(storedConfig.apiConfigs["delete-cloud"]).toBeUndefined()
			expect(storedConfig.apiConfigs["keep-cloud"]).toBeUndefined()

			// Check updates
			expect(storedConfig.apiConfigs["updated-keep"]).toEqual({
				id: "cloud-id-1",
				apiProvider: "anthropic",
				apiModelId: "claude-3-opus-20240229",
			})
			expect(JSON.stringify(storedConfig)).not.toContain("secret1")

			// Check renames
			expect(storedConfig.apiConfigs["rename-me_local"]).toEqual({
				id: "local-id",
				apiProvider: "vertex",
			})
			expect(storedConfig.apiConfigs["rename-me"]).toEqual({
				id: "cloud-id-3",
				apiProvider: "openai",
			})

			// Check new additions
			expect(storedConfig.apiConfigs["new-cloud"]).toEqual({
				id: "cloud-id-4",
				apiProvider: "vertex",
			})

			expect(storedConfig.cloudProfileIds).toEqual(["cloud-id-1", "cloud-id-3", "cloud-id-4"])
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default-id" } },
					cloudProfileIds: [],
				}),
			)
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.syncCloudProfiles({})).rejects.toThrow(
				"Failed to sync cloud profiles: Error: Failed to write provider profiles to secrets: Error: Storage failed",
			)
		})

		it("should track active profile changes when active profile is updated", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "active-profile",
				apiConfigs: {
					"active-profile": {
						id: "active-id",
						apiProvider: "anthropic" as const,
						apiKey: "old-key",
					},
				},
				cloudProfileIds: ["active-id"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"active-profile": {
					id: "active-id",
					apiProvider: "anthropic" as const,
					apiModelId: "claude-3-opus-20240229", // Updated setting
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles, "active-profile")

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(true)
			expect(result.activeProfileId).toBe("active-id")
		})

		it("should track active profile changes when active profile is deleted", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "active-profile",
				apiConfigs: {
					"active-profile": { id: "active-id", apiProvider: "anthropic" as const },
					"backup-profile": { id: "backup-id", apiProvider: "openai" as const },
				},
				cloudProfileIds: ["active-id"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {} // Active profile deleted

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles, "active-profile")

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(true)
			expect(result.activeProfileId).toBe("backup-id") // Should switch to first available
		})

		it("should create default profile when all profiles are deleted", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "only-profile",
				apiConfigs: {
					"only-profile": { id: "only-id", apiProvider: "anthropic" as const },
				},
				cloudProfileIds: ["only-id"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {} // All profiles deleted

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles, "only-profile")

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(true)
			expect(result.activeProfileId).toBeTruthy() // Should have new default profile ID

			const storedConfig = unwrapStoredProfiles(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.apiConfigs["default"]).toBeDefined()
			expect(storedConfig.apiConfigs["default"].id).toBe(result.activeProfileId)
		})

		it("should not mark active profile as changed when it's not affected", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "local-profile",
				apiConfigs: {
					"local-profile": { id: "local-id", apiProvider: "anthropic" as const },
					"cloud-profile": { id: "cloud-id", apiProvider: "openai" as const },
				},
				cloudProfileIds: ["cloud-id"],
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const cloudProfiles = {
				"cloud-profile": {
					id: "cloud-id",
					apiProvider: "openai" as const,
					apiModelId: "gpt-4", // Updated cloud profile
				},
			}

			const result = await providerSettingsManager.syncCloudProfiles(cloudProfiles, "local-profile")

			expect(result.hasChanges).toBe(true)
			expect(result.activeProfileChanged).toBe(false)
			expect(result.activeProfileId).toBe("local-id")
		})
	})

	describe("generateId", () => {
		// Regression test for CodeQL insecure-randomness alerts #9/#10:
		// generateId previously returned Math.random().toString(36).substring(2,15).
		// The id flows into profileId which indexes stored secrets
		// (allSecrets[profileId]), so a non-cryptographic PRNG made
		// secret-store keys predictable. generateId is public on the class,
		// so we can call it directly for an isolated white-box check.

		it("does not use Math.random (CSPRNG, not a non-cryptographic PRNG)", () => {
			const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => 0)
			const id = providerSettingsManager.generateId()
			expect(randomSpy).not.toHaveBeenCalled()
			// Belt-and-suspenders: if Math.random (mocked to 0) had been used,
			// the old implementation would have produced an empty string.
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
			randomSpy.mockRestore()
		})

		it("returns a UUID v4 string (CSPRNG shape)", () => {
			const id = providerSettingsManager.generateId()
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
		})

		it("produces unique ids across many calls (collision sanity)", () => {
			const ids = new Set<string>()
			for (let i = 0; i < 1000; i++) {
				ids.add(providerSettingsManager.generateId())
			}
			expect(ids.size).toBe(1000)
		})
	})
})
