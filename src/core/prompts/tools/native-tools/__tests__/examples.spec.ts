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

/**
 * Minimal JSON-Schema conformance checker.
 *
 * Key-set checks alone let a wrong VALUE through: an example could carry every required
 * key and still be a call the model cannot copy (a string where the schema wants an array,
 * an object item missing a required field, an enum value that does not exist). A real
 * validator is not available here on purpose: `ajv` is only a devDependency of
 * `packages/types` and is not importable from `src`, and pulling a new dependency into the
 * extension for one spec is not worth it.
 *
 * This covers every construct the native tool schemas actually use: scalar types, union
 * types (`["string", "null"]`), `enum`, arrays with scalar or object items, and one level of
 * nested objects with `required` plus `additionalProperties: false`. Unknown type keywords
 * are accepted rather than failed, so a future construct shows up as a gap in coverage, not
 * as a false alarm. `checkAgainstSchema` is itself covered by the negative self-tests below.
 */
type MiniSchema = {
	type?: string | string[]
	enum?: readonly unknown[]
	properties?: Record<string, MiniSchema>
	required?: readonly string[]
	items?: MiniSchema
	additionalProperties?: boolean
}

function describeValue(value: unknown): string {
	if (value === null) {
		return "null"
	}
	if (Array.isArray(value)) {
		return "array"
	}
	return typeof value
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "null":
			return value === null
		case "string":
			return typeof value === "string"
		case "number":
			return typeof value === "number"
		case "integer":
			return typeof value === "number" && Number.isInteger(value)
		case "boolean":
			return typeof value === "boolean"
		case "array":
			return Array.isArray(value)
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value)
		default:
			// Unknown keyword: report nothing rather than invent a failure.
			return true
	}
}

function checkAgainstSchema(value: unknown, schema: MiniSchema, path: string): string[] {
	const violations: string[] = []
	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]

	if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
		// A wrong type makes every deeper check meaningless, so stop here.
		return [`${path}: expected ${types.join(" or ")}, got ${describeValue(value)}`]
	}

	if (schema.enum && !schema.enum.includes(value)) {
		violations.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
	}

	if (Array.isArray(value) && schema.items) {
		value.forEach((item, index) => {
			violations.push(...checkAgainstSchema(item, schema.items!, `${path}[${index}]`))
		})
	}

	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const object = value as Record<string, unknown>

		for (const key of schema.required ?? []) {
			if (!(key in object)) {
				violations.push(`${path}.${key}: required by the schema but missing from the example`)
			}
		}

		for (const [key, entry] of Object.entries(object)) {
			const property = schema.properties?.[key]

			if (!property) {
				if (schema.additionalProperties === false) {
					violations.push(`${path}.${key}: not declared by the schema (additionalProperties is false)`)
				}
				continue
			}

			violations.push(...checkAgainstSchema(entry, property, `${path}.${key}`))
		}
	}

	return violations
}

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

	it.each(advertised.map((fn) => [fn.name, fn] as const))("%s example matches its schema types", (name, fn) => {
		const example = getToolMinimalExample(name)

		expect(example).toBeDefined()
		expect(checkAgainstSchema(example, (fn.parameters ?? {}) as MiniSchema, name)).toEqual([])
	})

	it("advertises no tool that lacks an example", () => {
		const withoutExample = advertised.map((fn) => fn.name).filter((name) => !getToolMinimalExample(name))

		expect(withoutExample).toEqual([])
	})

	describe("the conformance checker itself catches what it claims to catch", () => {
		function schemaOf(toolName: string): MiniSchema {
			const fn = advertised.find((candidate) => candidate.name === toolName)

			expect(fn).toBeDefined()
			return (fn!.parameters ?? {}) as MiniSchema
		}

		it("reports a scalar whose type is wrong", () => {
			// `todos` is a string in the schema; an array is the classic weak-model mistake.
			const violations = checkAgainstSchema({ todos: [] }, schemaOf("update_todo_list"), "update_todo_list")

			expect(violations).toHaveLength(1)
			expect(violations[0]).toContain("update_todo_list.todos")
			expect(violations[0]).toContain("got array")
		})

		it("reports a missing required key", () => {
			const violations = checkAgainstSchema({ path: "src/app.ts" }, schemaOf("apply_diff"), "apply_diff")

			expect(violations).toEqual(["apply_diff.diff: required by the schema but missing from the example"])
		})

		it("reports a key the schema does not declare", () => {
			const violations = checkAgainstSchema(
				{ path: "src", recursive: false, depth: 2 },
				schemaOf("list_files"),
				"list_files",
			)

			expect(violations).toHaveLength(1)
			expect(violations[0]).toContain("list_files.depth")
		})

		it("reports violations inside array items, one level down", () => {
			const violations = checkAgainstSchema(
				{ subtasks: [{ message: 1 }], maxConcurrency: null },
				schemaOf("run_parallel_tasks"),
				"run_parallel_tasks",
			)

			// Wrong type for `message` AND the missing required `mode` of the same item.
			expect(violations).toHaveLength(2)
			expect(violations.join("\n")).toContain("run_parallel_tasks.subtasks[0].message")
			expect(violations.join("\n")).toContain("run_parallel_tasks.subtasks[0].mode")
		})

		it("reports a value outside an enum", () => {
			const violations = checkAgainstSchema(
				{ path: "src/app.ts", mode: "semantic" },
				schemaOf("read_file"),
				"read_file",
			)

			expect(violations).toHaveLength(1)
			expect(violations[0]).toContain("read_file.mode")
			expect(violations[0]).toContain("slice")
		})

		it("accepts null for a nullable union type", () => {
			expect(
				checkAgainstSchema({ path: "src", regex: "x", file_pattern: null }, schemaOf("search_files"), "sf"),
			).toEqual([])
		})
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
