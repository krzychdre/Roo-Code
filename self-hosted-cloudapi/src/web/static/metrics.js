/*
 * Renders the usage-metrics charts with Chart.js (vendored, no CDN).
 *
 * Input: a JSON island #metrics-data produced by metrics_service.compute_user_metrics
 *   { days, day_tokens, day_cost, model_labels, model_tokens, mode_labels, mode_tokens }
 *
 * Best-effort, like live.js: if Chart didn't load we leave the (already
 * server-rendered) tables and summary cards untouched.
 */
;(function () {
	"use strict"

	if (typeof window.Chart === "undefined") return

	var dataEl = document.getElementById("metrics-data")
	if (!dataEl) return
	var data
	try {
		data = JSON.parse(dataEl.textContent || "{}")
	} catch (e) {
		return
	}

	// Mirrors the data hues in app.css. Tokens are "in" (cold cyan) and cost is
	// the signal amber, so the daily chart uses the same encoding as the stat
	// cards above it — a reader learns the colour once.
	var TOKENS = "#6cc4f5"
	var COST = "#e9a33a"
	var GRID = "rgba(255,255,255,0.06)"
	var TEXT = "#6b7885"
	var PANEL = "#141a22"
	// Categorical hues for the model/mode doughnuts. Ordered so adjacent
	// segments never sit on neighbouring hues, which keeps small slices legible.
	var PALETTE = [
		"#6cc4f5",
		"#a78bfa",
		"#4ec9a0",
		"#e9a33a",
		"#f2777a",
		"#6a9bf4",
		"#d6b4fc",
		"#8fd6bd",
		"#f5b855",
		"#93b7f7",
	]

	Chart.defaults.color = TEXT
	Chart.defaults.font.family =
		'ui-monospace, "JetBrains Mono", "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace'
	Chart.defaults.font.size = 11

	function fmtTokens(n) {
		var num = Number(n) || 0
		var units = [
			[1e9, "B"],
			[1e6, "M"],
			[1e3, "k"],
		]
		for (var i = 0; i < units.length; i++) {
			if (Math.abs(num) >= units[i][0]) {
				return (num / units[i][0]).toFixed(1).replace(/\.0$/, "") + units[i][1]
			}
		}
		return String(Math.round(num))
	}

	function get(id) {
		return document.getElementById(id)
	}

	// Per-day tokens (bars) + cost (line on a second axis).
	var dailyEl = get("chart-daily")
	if (dailyEl && data.days && data.days.length) {
		new Chart(dailyEl, {
			data: {
				labels: data.days,
				datasets: [
					{
						type: "bar",
						label: "Tokens",
						data: data.day_tokens,
						backgroundColor: TOKENS,
						borderRadius: 3,
						yAxisID: "y",
						order: 2,
					},
					{
						type: "line",
						label: "Cost ($)",
						data: data.day_cost,
						borderColor: COST,
						backgroundColor: COST,
						tension: 0.3,
						pointRadius: 3,
						yAxisID: "yCost",
						order: 1,
					},
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: { mode: "index", intersect: false },
				plugins: {
					legend: { labels: { boxWidth: 12 } },
					tooltip: {
						callbacks: {
							label: function (ctx) {
								if (ctx.dataset.yAxisID === "yCost") {
									return "Cost: $" + Number(ctx.parsed.y).toFixed(4)
								}
								return "Tokens: " + Number(ctx.parsed.y).toLocaleString()
							},
						},
					},
				},
				scales: {
					x: { grid: { color: GRID } },
					y: {
						position: "left",
						grid: { color: GRID },
						ticks: { callback: fmtTokens },
					},
					yCost: {
						position: "right",
						grid: { drawOnChartArea: false },
						ticks: {
							callback: function (v) {
								return "$" + v
							},
						},
					},
				},
			},
		})
	}

	function doughnut(elId, labels, values) {
		var el = get(elId)
		if (!el || !labels || !labels.length) return
		new Chart(el, {
			type: "doughnut",
			data: {
				labels: labels,
				datasets: [
					{
						data: values,
						backgroundColor: labels.map(function (_, i) {
							return PALETTE[i % PALETTE.length]
						}),
						borderColor: PANEL,
						borderWidth: 2,
					},
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				cutout: "58%",
				plugins: {
					legend: { position: "bottom", labels: { boxWidth: 12 } },
					tooltip: {
						callbacks: {
							label: function (ctx) {
								return ctx.label + ": " + fmtTokens(ctx.parsed) + " tokens"
							},
						},
					},
				},
			},
		})
	}

	doughnut("chart-models", data.model_labels, data.model_tokens)
	doughnut("chart-modes", data.mode_labels, data.mode_tokens)
})()
