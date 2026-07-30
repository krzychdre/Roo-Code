/*
 * Lightweight read-only renderer for a Tumble Code task conversation.
 *
 * Input: a ClineMessage[] (packages/types/src/message.ts) embedded as JSON in
 * #messages-data. Each message is a {type:"ask"|"say", ask?, say?, text?, ...}.
 * We render a vertical list of rows — the same flow as the extension chat —
 * classifying each message into a role for styling. Markdown is rendered with
 * marked and sanitized with DOMPurify (content can come from public shares).
 */
;(function () {
	"use strict"

	marked.setOptions({ breaks: true, gfm: true })

	function md(text) {
		if (!text) return ""
		return DOMPurify.sanitize(marked.parse(String(text)))
	}

	// Roo Code's first user turn (and resumed turns) can arrive wrapped: the typed
	// text inside <user_message>/<task>/<feedback>, trailed by a machine-built
	// <environment_details> block (current mode, open tabs, file tree, cost…).
	// Render the human query; tuck the environment block into a collapsed fold so
	// the full original is still one click away. Plain text passes through as-is.
	function userContentHtml(text) {
		if (!text) return ""
		let body = String(text)
		let env = ""
		const envMatch = body.match(/<environment_details>([\s\S]*?)(?:<\/environment_details>|$)/)
		if (envMatch) {
			env = envMatch[1].trim()
			body = body.slice(0, envMatch.index) + body.slice(envMatch.index + envMatch[0].length)
		}
		const wrap = body.match(/<(user_message|task|feedback)>([\s\S]*?)<\/\1>/)
		if (wrap) body = wrap[2]
		let html = md(body.trim())
		if (env) {
			html +=
				'<details class="env-details"><summary>Environment details</summary>' +
				"<pre><code>" +
				escapeHtml(env) +
				"</code></pre></details>"
		}
		return html
	}

	function escapeHtml(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
	}

	function fmtTime(ts) {
		const d = new Date(Number(ts))
		if (isNaN(d)) return ""
		return d.toLocaleString()
	}

	function fmtDuration(ms) {
		if (ms == null || ms < 0) return ""
		if (ms < 1000) return Math.round(ms) + "ms"
		const s = ms / 1000
		if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + "s"
		const m = Math.floor(s / 60)
		const r = Math.round(s % 60)
		return m + "m " + r + "s"
	}

	function firstLine(text, max) {
		const line = String(text == null ? "" : text).split("\n")[0]
		return line.length > max ? line.slice(0, max - 1) + "…" : line
	}

	function tryParse(text) {
		if (typeof text !== "string") return null
		const t = text.trim()
		if (!t.startsWith("{") && !t.startsWith("[")) return null
		try {
			return JSON.parse(t)
		} catch (e) {
			return null
		}
	}

	function codeBlock(content, lang) {
		return "<pre><code>" + escapeHtml(content) + "</code></pre>"
	}

	// Returns { role, label, detail?, body(html) } or null to skip the message.
	//
	// `label` is the ROLE word and is set in uppercase mono, like a panel label.
	// `detail` is content — a shell command, a file path, a token count — and is
	// kept verbatim. They are separate fields because the two are typeset
	// differently: uppercasing a `label + " · " + content` string mangled real
	// commands and paths ("uv run pytest" rendered as "UV RUN PYTEST").
	function classify(m) {
		const kind = m.say || m.ask || m.type

		// Messages with no renderable payload.
		if (kind === "api_req_finished") return null

		switch (kind) {
			case "user_feedback":
			case "user_feedback_diff":
				return { role: "user", label: "You", body: userContentHtml(m.text) }

			case "text":
				if (!m.text && !(m.images && m.images.length)) return null
				return {
					role: "assistant",
					label: "Assistant",
					body: userContentHtml(m.text) + images(m),
					activity: "Responding…",
				}

			case "reasoning":
				if (!m.text && !m.reasoning) return null
				return {
					role: "reasoning",
					label: "Reasoning",
					body: md(m.text || m.reasoning),
					activity: "Thinking…",
				}

			case "completion_result":
				// The result `say` carries the text; the trailing empty `ask` would
				// otherwise render a redundant "Task completed." row — drop it.
				if (!m.text) return null
				return { role: "completion", label: "Result", body: md(m.text) }

			case "command":
				return {
					role: "command",
					label: "Command",
					detail: firstLine(m.text, 80),
					body: codeBlock(m.text || ""),
					activity: "Running command…",
				}

			case "command_output":
				if (!m.text) return null
				return { role: "output", label: "Output", body: codeBlock(m.text) }

			case "error":
			case "diff_error":
			case "rooignore_error":
			case "mistake_limit_reached":
			case "api_req_failed":
				return { role: "error", label: "Error", body: md(m.text) || "<em>An error occurred.</em>" }

			case "api_req_started":
				return apiReq(m)

			case "tool":
				return toolMsg(m)

			case "followup":
				return followup(m)

			case "use_mcp_server":
			case "mcp_server_request_started":
			case "mcp_server_response":
				if (!m.text) return null
				return { role: "mcp", label: "MCP", body: renderMaybeJson(m.text) }

			case "checkpoint_saved":
				return {
					role: "system",
					label: "Checkpoint",
					body: "<span class='kv'>Checkpoint saved</span>",
				}

			case "condense_context":
				return {
					role: "system",
					label: "Context condensed",
					body:
						m.contextCondense && m.contextCondense.summary
							? md(m.contextCondense.summary)
							: "<span class='kv'>Conversation context was summarized.</span>",
				}

			case "subtask_result":
				return { role: "completion", label: "Subtask result", body: md(m.text) }

			case "image":
				return { role: "assistant", label: "Image", body: images(m) }

			default:
				if (!m.text) return null
				return { role: "system", label: kind || "Message", body: renderMaybeJson(m.text) }
		}
	}

	function images(m) {
		if (!m.images || !m.images.length) return ""
		return (
			'<div class="img-msg">' +
			m.images
				.map(function (src) {
					return '<img alt="attachment" src="' + escapeHtml(src) + '">'
				})
				.join("") +
			"</div>"
		)
	}

	function renderMaybeJson(text) {
		const obj = tryParse(text)
		if (obj) return codeBlock(JSON.stringify(obj, null, 2))
		return md(text)
	}

	// message ts -> {model, mode}: which model answered each request. The stored
	// api_req_started payload carries tokens and cost but no model, so the server
	// joins it against LLM Completion telemetry and hands the result over
	// separately (see services/model_attribution). Empty for a live row whose
	// completion event has not landed yet — a request with no known model shows
	// no badge rather than a guessed one.
	let requestModels = {}

	function modelOf(m) {
		if (m == null || m.ts == null) return null
		const hit = requestModels[String(m.ts)]
		return hit && hit.model ? hit : null
	}

	function apiReq(m) {
		const obj = tryParse(m.text) || {}
		const bits = []
		if (obj.tokensIn != null || obj.tokensOut != null) {
			bits.push("↑" + (obj.tokensIn || 0) + " ↓" + (obj.tokensOut || 0))
		}
		if (obj.cost != null) bits.push("$" + Number(obj.cost).toFixed(4))
		// One-liner: the figures ride in the row's detail; the body holds only the
		// optional folded request prompt. No cost yet → the request is in flight.
		const body = obj.request ? md(obj.request) : ""
		const active = obj.cost == null && obj.cancelReason == null && obj.streamingFailedMessage == null
		const attribution = modelOf(m)
		return {
			role: "api",
			label: "API",
			// The model reads before the figures: on a run that switched models
			// mid-task, *what* answered is what the eye is scanning the column for.
			badge: attribution ? attribution.model : "",
			badgeTitle: attribution && attribution.mode ? attribution.model + " · " + attribution.mode : "",
			detail: bits.join("  "),
			body: body,
			active: active,
			activity: "Calling API…",
		}
	}

	function toolMsg(m) {
		const obj = tryParse(m.text)
		if (!obj)
			return {
				role: "tool",
				label: "Tool",
				body: md(m.text),
				activity: "Running tool…",
			}
		const name = obj.tool || "tool"
		let inner = ""
		if (obj.path) inner += '<div class="path">' + escapeHtml(obj.path) + "</div>"
		if (obj.diff) inner += codeBlock(obj.diff, "diff")
		else if (obj.content) inner += codeBlock(obj.content)
		else if (obj.query) inner += '<div class="kv">query: ' + escapeHtml(obj.query) + "</div>"
		if (!inner) inner = codeBlock(JSON.stringify(obj, null, 2))
		return {
			role: "tool",
			label: name,
			detail: obj.path || "",
			body: inner,
			activity: "Running tool…",
		}
	}

	function followup(m) {
		const obj = tryParse(m.text)
		let body
		if (obj && obj.question) {
			body = md(obj.question)
			const sug = obj.suggest || obj.suggestions
			if (Array.isArray(sug) && sug.length) {
				body +=
					"<ul>" +
					sug
						.map(function (s) {
							const txt = typeof s === "string" ? s : (s && s.answer) || ""
							return "<li>" + escapeHtml(txt) + "</li>"
						})
						.join("") +
					"</ul>"
			}
		} else {
			body = md(m.text)
		}
		return { role: "assistant", label: "Question", body: body }
	}

	// Which roles start expanded.
	//
	// The rule is the reader's job, not the message kind: a first pass through a
	// conversation follows the narrative — what you asked, what the assistant
	// answered, what came out, and what broke. Everything else is machinery
	// (reasoning traces, tool payloads, command output, API envelopes) and is
	// there to be opened on demand, not to be scrolled past.
	const OPEN_BY_DEFAULT = {
		user: true,
		assistant: true,
		completion: true,
		error: true,
	}

	// Every role classify() can return. Fixed set, so the stylesheet can carry
	// static per-role visibility rules and the toolbar can label its filters.
	const ROLE_LABELS = {
		user: "You",
		assistant: "Assistant",
		reasoning: "Reasoning",
		completion: "Result",
		command: "Commands",
		output: "Output",
		tool: "Tools",
		mcp: "MCP",
		api: "API",
		error: "Errors",
		system: "System",
	}

	function rowEl(info, ts, active, openState) {
		const el = document.createElement("div")
		// EVERY row that has a body folds. This used to be a per-kind flag that
		// only some branches set, so a user message, a result, an error, a
		// condensed-context summary or a subtask result could never be collapsed
		// no matter how long it ran.
		const foldable = !!info.body
		el.className = "msg role-" + info.role + (active ? " running" : "") + (foldable ? " foldable" : "")
		if (ts != null) el.setAttribute("data-ts", String(ts))
		const spinner = active ? '<span class="spinner" aria-hidden="true"></span>' : ""
		// Right-aligned meta: absolute time (+ step duration, backfilled later).
		const time = ts != null ? '<span class="msg-time">' + escapeHtml(fmtTime(ts)) + "</span>" : ""
		const meta = '<span class="msg-meta">' + time + '<span class="msg-dur"></span></span>'
		// Role word and content are separate elements so the stylesheet can set
		// the first as a panel label (uppercase, tracked) without mangling the
		// second, which is a verbatim command, path or figure.
		const detail = info.detail ? '<span class="msg-detail">' + escapeHtml(info.detail) + "</span>" : ""
		// Provenance, not content: styled as a badge so it never reads as part of
		// the verbatim command/path/figure the detail carries.
		const badge = info.badge
			? '<span class="msg-model"' +
				(info.badgeTitle ? ' title="' + escapeHtml(info.badgeTitle) + '"' : "") +
				">" +
				escapeHtml(info.badge) +
				"</span>"
			: ""
		const headInner =
			'<span class="msg-role">' + escapeHtml(info.label) + "</span>" + badge + detail + spinner + meta

		if (foldable) {
			const open = openState == null ? !!OPEN_BY_DEFAULT[info.role] : openState
			// The summary IS the header — one collapsible line that expands in place,
			// instead of a header row stacked on a redundant "Show…" summary.
			el.innerHTML =
				"<details" +
				(open ? " open" : "") +
				'><summary class="msg-head">' +
				headInner +
				"</summary>" +
				'<div class="msg-body">' +
				info.body +
				"</div></details>"
		} else {
			// A true one-liner: nothing to reveal (e.g. an in-flight API request).
			el.innerHTML = '<div class="msg-head">' + headInner + "</div>"
		}
		return el
	}

	function foldStateOf(el) {
		const d = el && el.querySelector(":scope > details")
		return d ? d.open : null
	}

	// Badge an answered ask row so the reader can see the decision after the fact.
	function resolutionBadge(decision) {
		const span = document.createElement("span")
		span.className = "ask-resolution " + decision
		span.textContent = decision === "approved" ? "✓ Approved" : decision === "denied" ? "✗ Denied" : "✓ Answered"
		return span
	}

	// A live-updatable conversation: renders rows keyed by message `ts` so a
	// streaming message (created → partial → final, all one ts) replaces its row
	// in place instead of appending duplicates — mirroring the live VS Code view.
	function mountConversation(container) {
		const byTs = {}
		const rawByTs = {} // key -> latest raw message, for token/cost metrics
		const activeByTs = {} // key -> { ts, label }, for the "executing now" indicator
		const resolvedByTs = {} // key -> "approved"|"denied", survives row replacement
		const foldByTs = {} // key -> bool: a fold the reader set, kept across upserts
		const rolesSeen = {} // role -> true, for building the filter chips
		let activeAsk = null // { ts, onApprove, onDeny, ... } — the pending approval
		let tail = null // { ts, key, el } — last row in document order, for step duration
		let count = 0
		let lastCommandTs = null // owning command for trailing command_output rows
		// Set by "expand all" / "collapse all". While set it also decides how rows
		// arriving *afterwards* open, so a live task keeps obeying the choice
		// instead of reverting to the per-role default on the next message.
		let foldOverride = null

		// Row-identity key. Normally the message ts, but every `command_output` that
		// follows one `command` is ONE logical output block: the streaming tool emits
		// an orphaned partial say + a finalized say with different ts (an interleaved
		// command_output *ask* splits the say stream — see the ai_plan). Keying them to
		// the owning command collapses both onto one row (latest wins), mirroring the
		// VS Code chat's consolidateCommands. `ts` stays numeric for duration math.
		function keyOf(m) {
			const kind = m.say || m.ask || m.type
			if (kind === "command") {
				lastCommandTs = m.ts
				return m.ts
			}
			if (kind === "command_output") {
				return "cmdout@" + (lastCommandTs != null ? lastCommandTs : m.ts)
			}
			return m.ts
		}

		function clearPlaceholder() {
			const empty = container.querySelector(".empty, .loading")
			if (empty) empty.remove()
			container.removeAttribute("aria-busy")
		}

		function metaOf(el) {
			return el && (el.querySelector(".msg-meta") || el.querySelector(".msg-head"))
		}

		function applyResolution(el, decision) {
			if (!el || el.querySelector(".ask-resolution")) return
			const meta = metaOf(el)
			if (meta) meta.appendChild(resolutionBadge(decision))
		}

		function setDuration(el, ms) {
			const d = el && el.querySelector(".msg-dur")
			if (d && !d.textContent) d.textContent = " · " + fmtDuration(ms)
		}

		function copyDuration(from, to) {
			const a = from && from.querySelector(".msg-dur")
			const b = to && to.querySelector(".msg-dur")
			if (a && b && a.textContent) b.textContent = a.textContent
		}

		// Attach Approve/Deny to the ask's own conversation row (chronological,
		// coherent) instead of a detached bar. Buttons stop propagation so they
		// never toggle the row's fold.
		function decorateAsk(el) {
			if (!el || !activeAsk || resolvedByTs[el.getAttribute("data-ts")]) return
			el.classList.add("ask-pending")
			if (el.querySelector(".ask-actions-inline")) return
			const bar = document.createElement("div")
			bar.className = "ask-actions-inline"
			const spec = activeAsk
			const mkBtn = function (cls, text, fn) {
				const b = document.createElement("button")
				b.type = "button"
				b.className = "btn " + cls
				b.textContent = text
				b.addEventListener("click", function (e) {
					e.preventDefault()
					e.stopPropagation()
					fn()
				})
				return b
			}
			bar.appendChild(
				mkBtn("btn-approve", spec.approveLabel || "Approve", function () {
					spec.onApprove && spec.onApprove()
				}),
			)
			if (spec.showDeny !== false) {
				bar.appendChild(
					mkBtn("btn-deny", spec.denyLabel || "Deny", function () {
						spec.onDeny && spec.onDeny()
					}),
				)
			}
			el.appendChild(bar)
		}

		function undecorateAsk(el) {
			if (!el) return
			el.classList.remove("ask-pending")
			const bar = el.querySelector(".ask-actions-inline")
			if (bar) bar.remove()
		}

		function upsert(m, opts) {
			if (!m || typeof m !== "object") return
			if (m.partial && !m.text && !(m.images && m.images.length)) return
			const info = classify(m)
			if (!info) return
			clearPlaceholder()
			const ts = m.ts
			const key = keyOf(m)
			// A row is "running" while its message streams (partial) or, for an API
			// request, until it reports a cost. The in-place upsert of the final
			// message clears it automatically. Initial history replay (opts.history)
			// is a point-in-time snapshot, not a live stream — never animate it, or a
			// partial row persisted mid-stream would spin forever. A later live event
			// for the same key re-activates it and the finalize clears it.
			const active = !(opts && opts.history) && (!!m.partial || !!info.active)
			if (key != null) {
				rawByTs[key] = m
				if (active) activeByTs[key] = { ts: ts, label: info.activity || info.label }
				else delete activeByTs[key]
			}
			rolesSeen[info.role] = true
			const existing = key != null ? byTs[key] : null
			// Fold state belongs to the reader, not to the message. A streaming
			// message is re-rendered on every partial, so without carrying the
			// current state across the swap a row the reader opened would slam
			// shut on the next chunk. Precedence: what this row is showing right
			// now, then a fold the reader set on it earlier, then any global
			// expand/collapse, then the per-role default.
			const carried = existing ? foldStateOf(existing) : null
			const remembered = key != null && key in foldByTs ? foldByTs[key] : null
			const openState = carried != null ? carried : remembered != null ? remembered : foldOverride
			const fresh = rowEl(info, ts, active, openState)
			if (existing && existing.parentNode) {
				copyDuration(existing, fresh)
				existing.parentNode.replaceChild(fresh, existing)
				if (tail && tail.key === key) tail.el = fresh
			} else {
				// New step: the previous tail's duration is now known (gap to this ts).
				if (tail && tail.ts != null && ts != null && ts >= tail.ts) {
					setDuration(tail.el, ts - tail.ts)
				}
				container.appendChild(fresh)
				count++
				if (ts != null) tail = { ts: ts, key: key, el: fresh }
			}
			if (key != null) {
				byTs[key] = fresh
				if (resolvedByTs[key]) applyResolution(fresh, resolvedByTs[key])
				else if (activeAsk && activeAsk.ts === key) decorateAsk(fresh)
				// Remember a fold the reader sets, so it survives the next upsert.
				const details = fresh.querySelector(":scope > details")
				if (details) {
					details.addEventListener("toggle", function () {
						foldByTs[key] = details.open
					})
				}
			}
		}

		// Open or close every foldable row at once, and make the choice stick for
		// rows that arrive later (a live task keeps streaming while you read).
		function setAllFolds(open) {
			foldOverride = open
			Object.keys(byTs).forEach(function (key) {
				const details = byTs[key].querySelector(":scope > details")
				if (details) {
					details.open = open
					foldByTs[key] = open
				}
			})
		}

		function roles() {
			return Object.keys(rolesSeen)
		}

		// Show inline Approve/Deny on the ask row. `spec` carries the handlers.
		function setActiveAsk(ts, spec) {
			if (ts == null) {
				clearActiveAsk()
				return
			}
			if (activeAsk && activeAsk.ts !== ts) clearActiveAsk()
			if (resolvedByTs[ts]) return
			activeAsk = Object.assign({ ts: ts }, spec || {})
			decorateAsk(byTs[ts])
		}

		function clearActiveAsk() {
			if (activeAsk) undecorateAsk(byTs[activeAsk.ts])
			activeAsk = null
		}

		// Mark an answered ask (approve/deny) so the decision stays visible.
		function markResolved(ts, decision) {
			if (ts == null) return
			resolvedByTs[ts] = decision
			delete activeByTs[ts]
			if (activeAsk && activeAsk.ts === ts) activeAsk = null
			undecorateAsk(byTs[ts])
			applyResolution(byTs[ts], decision)
		}

		// Token/cost summary derived from the persisted conversation — the same
		// aggregation the VS Code view uses (consolidateTokenUsage): sum tokens/cost
		// over api_req_started (+ condense_context cost); contextTokens is the last
		// request's tokensIn+tokensOut (tokensIn already includes cache tokens).
		function getMetrics() {
			const m = { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 }
			const tss = Object.keys(rawByTs)
				.map(Number)
				.sort(function (a, b) {
					return a - b
				})
			tss.forEach(function (ts) {
				const msg = rawByTs[ts]
				if (!msg || msg.type !== "say") return
				if (msg.say === "api_req_started" && msg.text) {
					const o = tryParse(msg.text)
					if (!o) return
					if (typeof o.tokensIn === "number") m.totalTokensIn += o.tokensIn
					if (typeof o.tokensOut === "number") m.totalTokensOut += o.tokensOut
					if (typeof o.cost === "number") m.totalCost += o.cost
				} else if (msg.say === "condense_context" && msg.contextCondense) {
					m.totalCost += msg.contextCondense.cost || 0
				}
			})
			for (let i = tss.length - 1; i >= 0; i--) {
				const msg = rawByTs[tss[i]]
				if (!msg || msg.type !== "say") continue
				if (msg.say === "api_req_started" && msg.text) {
					const o = tryParse(msg.text)
					if (o) {
						m.contextTokens = (o.tokensIn || 0) + (o.tokensOut || 0)
					}
				} else if (msg.say === "condense_context" && msg.contextCondense) {
					m.contextTokens = msg.contextCondense.newContextTokens || 0
				}
				if (m.contextTokens) break
			}
			return m
		}

		// Label of the newest still-active row, or null when idle.
		function getActivity() {
			let bestTs = null
			let label = null
			Object.keys(activeByTs).forEach(function (k) {
				const a = activeByTs[k]
				const t = a && a.ts
				if (t != null && (bestTs == null || t > bestTs)) {
					bestTs = t
					label = a.label
				}
			})
			return label
		}

		function renderAll(messages) {
			;(messages || []).forEach(function (m) {
				upsert(m, { history: true })
			})
			if (count === 0) {
				container.innerHTML = '<div class="empty">This task has no messages.</div>'
			}
		}

		return {
			upsert: upsert,
			renderAll: renderAll,
			markResolved: markResolved,
			setActiveAsk: setActiveAsk,
			clearActiveAsk: clearActiveAsk,
			getActivity: getActivity,
			getMetrics: getMetrics,
			setAllFolds: setAllFolds,
			roles: roles,
			get count() {
				return count
			},
		}
	}

	// Exposed so the live controller (live.js) can reuse the exact same rendering.
	window.TumbleConversation = { mount: mountConversation }

	function localizeDates() {
		document.querySelectorAll(".task-date[data-ts], .cell-date[data-ts]").forEach(function (el) {
			const d = new Date(el.getAttribute("data-ts"))
			if (!isNaN(d)) el.textContent = d.toLocaleString()
		})
	}

	// Controls above the conversation: expand/collapse everything, and mute a
	// whole kind of row. Built here rather than in the template because the
	// filter chips should only offer the kinds this particular task actually
	// contains — a conversation with no MCP calls should not advertise an MCP
	// filter. Order follows ROLE_LABELS so the strip reads the same everywhere.
	function mountToolbar(host, container, convo) {
		const present = convo.roles()
		if (!present.length) return

		const bar = document.createElement("div")
		bar.className = "convo-toolbar"

		const filters = document.createElement("div")
		filters.className = "convo-filters"
		Object.keys(ROLE_LABELS).forEach(function (role) {
			if (present.indexOf(role) === -1) return
			const chip = document.createElement("button")
			chip.type = "button"
			chip.className = "chip role-" + role + " on"
			chip.textContent = ROLE_LABELS[role]
			chip.setAttribute("aria-pressed", "true")
			chip.addEventListener("click", function () {
				const showing = chip.classList.toggle("on")
				chip.setAttribute("aria-pressed", String(showing))
				container.classList.toggle("hide-" + role, !showing)
			})
			filters.appendChild(chip)
		})

		const folds = document.createElement("div")
		folds.className = "convo-folds"
		;[
			["Expand all", true],
			["Collapse all", false],
		].forEach(function (spec) {
			const b = document.createElement("button")
			b.type = "button"
			b.className = "btn ghost btn-fold"
			b.textContent = spec[0]
			b.addEventListener("click", function () {
				convo.setAllFolds(spec[1])
			})
			folds.appendChild(b)
		})

		bar.appendChild(filters)
		bar.appendChild(folds)
		host.insertBefore(bar, container)
	}

	function init() {
		localizeDates()
		const container = document.getElementById("conversation")
		const dataEl = document.getElementById("messages-data")
		if (!container || !dataEl) return

		let messages = []
		try {
			messages = JSON.parse(dataEl.textContent || "[]")
		} catch (e) {
			container.innerHTML = '<div class="empty">Could not load this conversation.</div>'
			return
		}

		// Attribution is optional decoration — a conversation still renders in
		// full without it, so a missing or malformed island is not an error.
		const modelsEl = document.getElementById("request-models")
		if (modelsEl) {
			try {
				const parsed = JSON.parse(modelsEl.textContent || "{}")
				if (parsed && typeof parsed === "object") requestModels = parsed
			} catch (e) {
				/* leave it empty */
			}
		}

		container.innerHTML = ""
		const convo = mountConversation(container)
		convo.renderAll(messages)
		if (convo.count > 0 && container.parentNode) {
			mountToolbar(container.parentNode, container, convo)
		}

		// Hand the live controller (if loaded) the same conversation instance so
		// relayed events append to the history already on screen.
		window.__tumbleConversation = convo
		if (typeof window.TumbleLiveInit === "function") {
			try {
				window.TumbleLiveInit(convo)
			} catch (e) {
				/* live is best-effort */
			}
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init)
	} else {
		init()
	}
})()
