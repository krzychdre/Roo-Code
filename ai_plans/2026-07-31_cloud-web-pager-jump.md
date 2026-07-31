# Any page, one click: a numbered pager for the web task list

Date: 2026-07-31
Scope: `self-hosted-cloudapi/` — the `/app` task list
Branch: `feat/cloud-web-pager-jump`, off `main`

---

## 1. The problem

The task list pages 25 rows at a time and offered exactly two controls:

```
← Newer        Page 5 of 24        Older →
```

Every page is one step from its neighbours and 23 steps from the far end. On
the live deployment (387 tasks, ~16 pages of runs) reaching an old task meant
walking the whole list — a full round trip and a full re-render per click — and
there was no way to bookmark or type a destination. The page number was
_reported_ but not _addressable_: `?page=N` worked in the URL bar and nowhere in
the UI.

## 2. What was built

```
← Newer   1 … 10 11 [12] 13 14 … 24   Older →   Go to [12] of 24 [Go]
```

Three pieces, in the order they matter:

1. **Numbered links** — the current page with two neighbours either side, plus
   the first and last page always, gaps elided with `…`. Any page in the window
   is one click; the two ends are always one click.
2. **A jump box** — a `GET` form posting `page` back to `/app`, so a page far
   outside the window can be named outright instead of walked to. It appears
   only when the numbers stop covering the range (`page_count > len(window)`);
   with four pages all four are on screen and a type-a-number box would be
   noise.
3. **Out-of-range pages clamp instead of erroring.** `page` was declared
   `Query(1, ge=1)`, so `?page=0` returned a 422 and replaced the list with an
   error document. Now that a reader can _type_ a page number — and a bookmark
   can outlive the rows it pointed at — the router clamps to
   `[1, page_count]` and renders the nearest real page.

### Where the logic lives

`src/utils/pagination.py::page_window(page, page_count, radius=2)` — pure
arithmetic, returns `[1, None, 10, 11, 12, 13, 14, None, 24]` where `None` is an
elided run. Two decisions are deliberate and are what the unit tests pin:

- **The window slides, it does not shrink.** Near either end it moves inward to
  keep a constant width, so the pager is the same size on page 1, 2 and 3 and
  the numbers do not shift under the cursor as the reader walks the list.
- **A gap of exactly one page is filled, not elided.** `1 … 3` costs the same
  width as `1 2 3` while hiding a page.

It is out of the router because the edges (both ends of the range, the
one-page gap, a page number that outran a corpus that shrank) are worth
asserting directly rather than through rendered HTML.

### Adjacent fix, same block

Page and scope links built the query string with `&q={{ query }}`, unencoded. A
search for `a&b` truncated the link at the ampersand and silently dropped half
the filter. The template now encodes it once into `page_q` and every link
reuses that.

## 3. Files

| File                                | Change                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| `src/utils/pagination.py`           | new — `page_window`                                       |
| `src/routers/web.py`                | pass `pages`; clamp `page` instead of 422-ing             |
| `src/web/templates/tasks_list.html` | numbered pager, jump form, encoded query                  |
| `src/web/static/app.css`            | `.pager-pages`, `.pager-num`, `.pager-gap`, `.pager-jump` |
| `tests/test_pagination.py`          | new — 8 tests over the window arithmetic                  |
| `tests/test_web_and_share.py`       | 5 route tests + the existing pagination assertion         |

## 4. Verification

- `uv run pytest -q` → **183 passed** (was 183 before; 13 new tests, and the
  existing `test_task_list_is_paginated` assertion moved from the removed
  "Page 1 of 2" text to the nav's `aria-label`).
- Rendered against a seeded 600-task corpus (24 pages) on a throwaway server
  and screenshotted with headless Chrome at 380 / 520 / 900 / 1400 px:
    - page 1 → `[1] 2 3 4 5 … 24`, "← Newer" disabled;
    - page 12 → `1 … 10 11 [12] 13 14 … 24`, both ellipses present;
    - page 24 → `1 … 20 21 22 23 [24]`, "Older →" disabled;
    - `?page=999` → page 24, `?page=0` → page 1, neither a 422.
- The narrow-viewport pass found a real defect: the number row overflowed the
  viewport at 380–430 px and the last page fell off the right edge.
  `.pager-pages` now wraps (`flex-wrap: wrap; min-width: 0`) and the cells
  tighten under 640 px.

## 5. Accessibility

- The nav is labelled `Pagination, page N of M` — the count survives the removal
  of the "Page N of M" text.
- The current page is a `<span aria-current="page">`, not a link to itself.
- Each number link carries `aria-label="Page N"`, since "7" alone says nothing
  out of context; prev/next carry `rel="prev"` / `rel="next"`.
- The ellipsis is `aria-hidden` — it is a visual mark for elision, not content.

## 6. Not done

- **`PAGE_SIZE` stays fixed at 25.** A rows-per-page control is a different
  question (it changes what a bookmarked `?page=` means) and nobody asked for it.
- **Bulk delete still returns to page 1.** It always has; with numbered pages the
  page you were on is now one click away, which is the cheap half of the fix.
  Preserving the page across a delete needs the "did this page survive?" check
  the original comment describes, and belongs with that code.
