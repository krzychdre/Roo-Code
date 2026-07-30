#!/usr/bin/env node
// vLLM prefix-cache probe (WS-8 of the verbosity/turn-economics plan).
//
// The client half of WS-8 is already fixed: `OpenAiHandler` now reads
// `prompt_tokens_details.cached_tokens`, so `cacheReads` carries whatever the
// server reports. This script settles the server half, which the response body
// alone cannot: vLLM can serve a prefix-cache hit and never mention it in
// `usage`. `/metrics` is the authoritative source.
//
// Decision matrix (printed at the end):
//   hits grow AND cached_tokens > 0   -> caching works and is reported; the
//                                        client-side `cacheReads` number is
//                                        trustworthy, judge WS-1 by it.
//   hits grow AND cached_tokens == 0  -> the server caches but stays silent;
//                                        `cacheReads` is a permanent lower
//                                        bound and only /metrics can judge WS-1.
//   hits flat, queries grow           -> prefix caching is on but nothing hits:
//                                        the prefix is unstable, or KV space is
//                                        too small and the block was evicted
//                                        between turns (raise
//                                        --gpu-memory-utilization).
//   no prefix_cache metrics at all    -> the server was very likely started with
//                                        --no-enable-prefix-caching, or the
//                                        attention backend / quantisation combo
//                                        silently disabled it.
//
// Two modes:
//   probe (default) — send the same ~20k-token request twice and diff the
//                     counters around it. Self-contained, no VS Code needed.
//   --watch         — snapshot counters, wait for Enter, snapshot again. Use it
//                     to wrap a REAL Roo task: this is the measurement that
//                     judges WS-1, because only a real task has the multi-turn
//                     prefix WS-1 was meant to stabilise.
//
// Usage:
//   node scripts/agent-bench/vllm-prefix-cache-probe.mjs \
//     [--metrics http://localhost:8000/metrics] [--base http://localhost:8000/v1] \
//     [--model glm-5.2] [--api-key ...] [--watch]
//
// Reads VLLM_METRICS_URL / VLLM_BASE_URL / VLLM_API_KEY when the flags are absent.

const args = process.argv.slice(2)

function flag(name, fallback) {
	const i = args.indexOf(`--${name}`)
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback
}

const metricsUrl = flag("metrics", process.env.VLLM_METRICS_URL ?? "http://localhost:8000/metrics")
const baseUrl = flag("base", process.env.VLLM_BASE_URL ?? "http://localhost:8000/v1").replace(/\/$/, "")
const apiKey = flag("api-key", process.env.VLLM_API_KEY ?? "dummy")
const watch = args.includes("--watch")

// vLLM v1 renamed these; accept both spellings so the probe works on either engine.
const COUNTERS = [
	["queries", ["vllm:gpu_prefix_cache_queries_total", "vllm:prefix_cache_queries_total"]],
	["hits", ["vllm:gpu_prefix_cache_hits_total", "vllm:prefix_cache_hits_total"]],
]

/** Sum every labelled series of a Prometheus counter, whichever name it uses. */
function sumMetric(text, names) {
	let total = null
	for (const name of names) {
		for (const line of text.split("\n")) {
			if (!line.startsWith(name)) continue
			const brace = line.indexOf("{")
			const head = brace >= 0 ? line.slice(0, brace) : line.split(" ")[0]
			if (head.trim() !== name) continue
			const value = Number.parseFloat(line.slice(line.lastIndexOf(" ") + 1))
			if (Number.isFinite(value)) total = (total ?? 0) + value
		}
		if (total !== null) return total
	}
	return total
}

async function snapshot() {
	let res
	try {
		res = await fetch(metricsUrl)
	} catch (err) {
		console.error(`GET ${metricsUrl} failed: ${err.message}`)
		console.error("Pass --metrics <url> or set VLLM_METRICS_URL; the server must be reachable.")
		process.exit(1)
	}
	if (!res.ok) {
		console.error(`GET ${metricsUrl} -> HTTP ${res.status}. Is this the vLLM server?`)
		process.exit(1)
	}
	const text = await res.text()
	const out = {}
	for (const [key, names] of COUNTERS) out[key] = sumMetric(text, names)
	return out
}

async function resolveModel() {
	const given = flag("model", null)
	if (given) return given
	try {
		const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
		const json = await res.json()
		const id = json?.data?.[0]?.id
		if (id) return id
	} catch {
		/* fall through to the explicit-flag error below */
	}
	console.error("Could not read /v1/models — pass --model <served-model-name>.")
	process.exit(1)
}

// ~20k tokens of deterministic filler, so the prefix is identical between calls
// and long enough to span several KV blocks.
const filler = Array.from(
	{ length: 2000 },
	(_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog, again and again, deterministically.`,
).join("\n")

async function call(model, label) {
	const started = Date.now()
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			stream: false,
			max_tokens: 16,
			messages: [
				{ role: "system", content: `You are a test assistant. Reference text:\n${filler}` },
				{ role: "user", content: "Reply with the single word: ok" },
			],
		}),
	})
	const elapsed = Date.now() - started
	if (!res.ok) {
		console.error(`${label}: HTTP ${res.status} ${await res.text()}`)
		process.exit(1)
	}
	const json = await res.json()
	const usage = json.usage ?? {}
	const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
	console.log(
		`${label}: ${elapsed} ms  prompt_tokens=${usage.prompt_tokens ?? "?"} ` +
			`cached_tokens=${usage.prompt_tokens_details ? cached : "(field absent)"}`,
	)
	return { elapsed, cached, reported: usage.prompt_tokens_details !== undefined }
}

function report(before, after, cachedTokens, reportedField) {
	const dq = before.queries === null ? null : after.queries - before.queries
	const dh = before.hits === null ? null : after.hits - before.hits

	console.log("\n--- /metrics delta ---")
	if (dq === null) {
		console.log("prefix_cache_queries_total: METRIC ABSENT")
		console.log(
			"\nVerdict: no prefix-cache metrics exposed. The server is almost certainly running\n" +
				"with --no-enable-prefix-caching, or the attention backend / quantisation combo\n" +
				"disabled it silently. Nothing about WS-1 can be judged from cacheReads until this\n" +
				"is fixed: re-launch with prefix caching on and re-run this probe.",
		)
		return
	}

	console.log(`queries: +${dq}`)
	console.log(`hits:    ${dh === null ? "METRIC ABSENT" : `+${dh}`}`)
	const rate = dq > 0 && dh !== null ? `${((100 * dh) / dq).toFixed(1)}%` : "n/a"
	console.log(`hit rate over the probe window: ${rate}`)

	console.log("\n--- verdict ---")
	if (dh && dh > 0) {
		if (cachedTokens > 0) {
			console.log(
				"Server caches AND reports it. `cacheReads` in task history is trustworthy —\n" +
					"judge WS-1 by the client-side number, and by tokens re-prefilled rather than by cost.",
			)
		} else {
			console.log(
				"Server caches but does NOT report it in the response body" +
					(reportedField ? " (field present, zero)" : " (field absent entirely)") +
					".\n`cacheReads` is a permanent lower bound on this profile: only /metrics can judge WS-1.",
			)
		}
	} else if (dq > 0) {
		console.log(
			"Prefix caching is enabled but nothing hit. Either the prefix is not byte-stable\n" +
				"between requests, or the KV blocks were evicted between them — check\n" +
				"--gpu-memory-utilization and whether another model shares the same GPU.",
		)
	} else {
		console.log("Counters did not move at all. Did the requests reach THIS server?")
	}
}

async function main() {
	console.log(`metrics: ${metricsUrl}`)
	const before = await snapshot()
	console.log(`baseline queries=${before.queries ?? "absent"} hits=${before.hits ?? "absent"}`)

	if (watch) {
		console.log(
			"\nWatch mode. Run the real Roo task now (a multi-turn one — that is the prefix WS-1\n" +
				"stabilises), then press Enter here.",
		)
		await new Promise((resolve) => {
			process.stdin.resume()
			process.stdin.once("data", resolve)
		})
		const after = await snapshot()
		// No body to inspect in watch mode: cross-check cacheReads with
		// `collect.py --recent 1` on the task that just finished.
		report(before, after, 0, false)
		console.log(
			"\nNow compare against the client side:\n" +
				"  python3 scripts/agent-bench/collect.py --recent 1\n" +
				"A hit rate here with cacheReads ~0 there means the server is silent, not cold.",
		)
		process.exit(0)
	}

	const model = await resolveModel()
	console.log(`model:   ${model}\n`)
	const first = await call(model, "cold ")
	const second = await call(model, "warm ")
	const after = await snapshot()
	report(before, after, second.cached, second.reported)
	if (second.elapsed < first.elapsed * 0.7) {
		console.log(
			`\nWall clock also dropped (${first.elapsed} ms -> ${second.elapsed} ms), which is the\n` +
				"saving that actually matters on self-hosted hardware: prefill time on a GPU that is\n" +
				"also decoding. A prefix hit does not save money here, it saves latency.",
		)
	}
}

main()
