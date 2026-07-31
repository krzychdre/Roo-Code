"""Which page numbers a pager should offer.

The task list only ever offered ``← Newer`` / ``Older →``, so reaching page 9
of 16 cost eight round trips. This computes the numbered window instead: the
current page with its neighbours, always plus the first and the last page, and
``None`` wherever a run of pages is elided (rendered as an ellipsis).

Kept out of the router because it is pure arithmetic with fiddly edges — the
ends of the range, a one-page gap, a corpus that shrank under the reader — and
those are worth asserting directly rather than through rendered HTML.
"""

# Pages shown around the current one. 2 → a window of 5 (e.g. 4 5 [6] 7 8),
# which with the two ends and two ellipses fits a single line on a phone.
RADIUS = 2


def page_window(page: int, page_count: int, radius: int = RADIUS) -> list[int | None]:
    """Page numbers to render, with ``None`` marking an elided run.

    ``page_window(6, 16)`` -> ``[1, None, 4, 5, 6, 7, 8, None, 16]``.

    The window keeps a constant width as the reader moves: near either end it
    slides inward instead of shrinking, so the pager does not change size (and
    the numbers do not jump under the cursor) between page 1 and page 3.

    A gap of exactly one page is filled with that page rather than an ellipsis:
    ``1 … 3`` costs the same width as ``1 2 3`` while hiding a page.
    """
    if page_count < 1:
        return []

    page = min(max(page, 1), page_count)
    size = min(2 * radius + 1, page_count)
    start = min(max(page - radius, 1), page_count - size + 1)
    shown = sorted({1, page_count, *range(start, start + size)})

    out: list[int | None] = []
    for number in shown:
        previous = out[-1] if out else None
        if isinstance(previous, int):
            if number == previous + 2:
                out.append(previous + 1)
            elif number > previous + 1:
                out.append(None)
        out.append(number)
    return out
