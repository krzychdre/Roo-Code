import { toolNames } from "@roo-code/types"

import { isValidArtifactId } from "../../../../artifacts/ArtifactStore"
import { getNativeTools } from "../index"
import { DYNAMIC_TOOL_NAMES, TOOL_MINIMAL_EXAMPLES, getToolMinimalExample } from "../examples"

describe("TOOL_MINIMAL_EXAMPLES", () => {
	const dynamicNames = DYNAMIC_TOOL_NAMES as readonly string[]
	const staticToolNames = toolNames.filter((name) => !dynamicNames.includes(name))

	it("covers every statically advertised tool name exactly once", () => {
		expect(Object.keys(TOOL_MINIMAL_EXAMPLES).sort()).toEqual([...staticToolNames].sort())
	})

	it("excludes only the names the model never sees in the advertised tool list", () => {
		const missing = toolNames.filter((name) => !(name in TOOL_MINIMAL_EXAMPLES))

		expect(missing.sort()).toEqual([...DYNAMIC_TOOL_NAMES].sort())
	})

	it.each(Object.entries(TOOL_MINIMAL_EXAMPLES))("%s is a non-empty plain JSON object", (_name, example) => {
		expect(Array.isArray(example)).toBe(false)
		expect(Object.keys(example).length).toBeGreaterThan(0)
		// Round-trips as JSON so it can be embedded as a nested object in a tool result.
		expect(JSON.parse(JSON.stringify(example))).toEqual(example)
	})

	it("never uses an em dash or en dash", () => {
		expect(JSON.stringify(TOOL_MINIMAL_EXAMPLES)).not.toMatch(/[\u2013\u2014]/)
	})

	it("uses an artifact_id the read_artifact validator accepts", () => {
		expect(isValidArtifactId(TOOL_MINIMAL_EXAMPLES.read_artifact.artifact_id)).toBe(true)
		expect(isValidArtifactId(TOOL_MINIMAL_EXAMPLES.read_command_output.artifact_id)).toBe(true)
	})
})

describe("TOOL_MINIMAL_EXAMPLES conforms to the advertised schemas", () => {
	const advertised = getNativeTools({ supportsImages: true })
		.filter((tool): tool is Extract<typeof tool, { function: unknown }> => "function" in tool)
		.map((tool) => tool.function)

	it("checks a meaningful number of tools", () => {
		expect(advertised.length).toBeGreaterThan(20)
	})

	it.each(advertised.map((fn) => [fn.name, fn] as const))("%s example matches its schema properties", (name, fn) => {
		const example = getToolMinimalExample(name)

		// Every advertised static tool must have an example.
		expect(example).toBeDefined()

		const parameters = (fn.parameters ?? {}) as {
			properties?: Record<string, unknown>
			required?: string[]
		}
		const properties = Object.keys(parameters.properties ?? {})
		const required = parameters.required ?? []
		const exampleKeys = Object.keys(example!)

		// No key the schema does not declare.
		expect(exampleKeys.filter((key) => !properties.includes(key))).toEqual([])
		// Every required key present.
		expect(required.filter((key) => !exampleKeys.includes(key))).toEqual([])
	})

	it("advertises no tool that lacks an example", () => {
		const withoutExample = advertised.map((fn) => fn.name).filter((name) => !getToolMinimalExample(name))

		expect(withoutExample).toEqual([])
	})
})

describe("getToolMinimalExample", () => {
	it("returns the example object for a known static tool", () => {
		expect(getToolMinimalExample("apply_diff")).toBe(TOOL_MINIMAL_EXAMPLES.apply_diff)
	})

	it("returns undefined for dynamic, MCP and unknown names", () => {
		expect(getToolMinimalExample("custom_tool")).toBeUndefined()
		expect(getToolMinimalExample("use_mcp_tool")).toBeUndefined()
		expect(getToolMinimalExample("mcp--my-server--my_tool")).toBeUndefined()
		expect(getToolMinimalExample("not_a_tool")).toBeUndefined()
		expect(getToolMinimalExample(undefined)).toBeUndefined()
	})
})
