/*
 * Task-list selection: checkboxes, shift-click ranges, and the bulk action bar.
 *
 * Progressive enhancement. The form and every button work without this file —
 * the bar starts hidden and is only revealed here, so with scripting off the
 * per-row Delete still posts and nothing on the page is a dead control.
 *
 * Confirmations are attached here rather than as inline `onsubmit` handlers so
 * the page needs no inline script, and so the bulk confirmation can state the
 * real count instead of a fixed sentence.
 */
;(function () {
	"use strict"

	var form = document.getElementById("bulk-form")
	if (!form) return

	var bar = document.getElementById("bulk-bar")
	var countEl = document.getElementById("bulk-n")
	var childrenEl = document.getElementById("bulk-children")
	var subtasksWrap = document.getElementById("bulk-subtasks-wrap")
	var includeSubtasks = document.getElementById("include-subtasks")
	var selectAll = document.getElementById("select-all")
	var clearBtn = document.getElementById("bulk-clear")
	var deleteBtn = document.getElementById("bulk-delete")

	function boxes() {
		return Array.prototype.slice.call(form.querySelectorAll('input[name="task_ids"]'))
	}

	function selected() {
		return boxes().filter(function (b) {
			return b.checked
		})
	}

	// How many subtasks the current selection would drag along. Read off the
	// rows themselves (each carries its own child count), so the offer is only
	// made when it would actually do something.
	function childCount(list) {
		return list.reduce(function (sum, b) {
			return sum + (Number(b.getAttribute("data-child-count")) || 0)
		}, 0)
	}

	function refresh() {
		var chosen = selected()
		var n = chosen.length
		if (countEl) countEl.textContent = String(n)
		if (bar) bar.hidden = n === 0

		var children = childCount(chosen)
		if (subtasksWrap) subtasksWrap.hidden = children === 0
		if (childrenEl) childrenEl.textContent = String(children)
		// A hidden checkbox must not keep a stale tick that would silently widen
		// the delete on the next submission.
		if (children === 0 && includeSubtasks) includeSubtasks.checked = false

		if (selectAll) {
			var all = boxes()
			selectAll.checked = n > 0 && n === all.length
			selectAll.indeterminate = n > 0 && n < all.length
		}

		boxes().forEach(function (b) {
			var row = b.closest(".task-item")
			if (row) row.classList.toggle("selected", b.checked)
		})
	}

	// Shift-click selects the range from the last box clicked, the way a file
	// manager does — the alternative for "delete these forty" is forty clicks.
	var lastIndex = null
	form.addEventListener("click", function (e) {
		var box = e.target
		if (!box || box.name !== "task_ids") return
		var all = boxes()
		var index = all.indexOf(box)
		if (e.shiftKey && lastIndex !== null && index !== -1) {
			var from = Math.min(lastIndex, index)
			var to = Math.max(lastIndex, index)
			for (var i = from; i <= to; i++) all[i].checked = box.checked
		}
		lastIndex = index
		refresh()
	})

	if (selectAll) {
		selectAll.addEventListener("change", function () {
			boxes().forEach(function (b) {
				b.checked = selectAll.checked
			})
			lastIndex = null
			refresh()
		})
	}

	if (clearBtn) {
		clearBtn.addEventListener("click", function () {
			boxes().forEach(function (b) {
				b.checked = false
			})
			lastIndex = null
			refresh()
		})
	}

	if (includeSubtasks) includeSubtasks.addEventListener("change", refresh)

	// --- confirmations -------------------------------------------------------

	// The per-row button posts to its own endpoint via formaction, so it must
	// confirm for itself; the submit listener below would otherwise ask the bulk
	// question for a single-row delete.
	form.addEventListener("click", function (e) {
		var btn = e.target.closest("[data-confirm]")
		if (!btn) return
		if (!window.confirm(btn.getAttribute("data-confirm"))) {
			e.preventDefault()
		} else {
			btn.setAttribute("data-confirmed", "1")
		}
	})

	form.addEventListener("submit", function (e) {
		var submitter = e.submitter
		if (submitter && submitter.hasAttribute("data-confirm")) {
			// Already answered in the click handler above.
			submitter.removeAttribute("data-confirmed")
			return
		}

		var n = selected().length
		if (n === 0) {
			e.preventDefault()
			return
		}
		var extra = includeSubtasks && includeSubtasks.checked ? childCount(selected()) : 0
		var what = n + " task" + (n === 1 ? "" : "s")
		if (extra) what += " and " + extra + " subtask" + (extra === 1 ? "" : "s")
		if (!window.confirm("Delete " + what + " permanently, with every conversation? This cannot be undone.")) {
			e.preventDefault()
			return
		}
		if (deleteBtn) deleteBtn.disabled = true
	})

	refresh()
})()
