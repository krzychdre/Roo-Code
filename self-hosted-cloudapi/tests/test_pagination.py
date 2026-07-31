"""The numbered pager window.

Pure arithmetic with fiddly edges (both ends of the range, a gap of exactly one
page, a page number that outran a corpus that shrank), asserted here directly
rather than through rendered HTML.
"""

from src.utils.pagination import page_window


def test_window_keeps_both_ends_and_elides_the_middle():
    assert page_window(8, 16) == [1, None, 6, 7, 8, 9, 10, None, 16]


def test_window_slides_inward_instead_of_shrinking_at_the_start():
    """The pager must not change width between page 1 and page 3, or the
    numbers move under the cursor as the reader walks the list."""
    assert page_window(1, 16) == [1, 2, 3, 4, 5, None, 16]
    assert page_window(2, 16) == [1, 2, 3, 4, 5, None, 16]
    assert page_window(3, 16) == [1, 2, 3, 4, 5, None, 16]


def test_window_slides_inward_at_the_end_too():
    assert page_window(16, 16) == [1, None, 12, 13, 14, 15, 16]
    assert page_window(15, 16) == [1, None, 12, 13, 14, 15, 16]


def test_a_single_hidden_page_is_shown_rather_than_elided():
    """"1 … 3" costs the same width as "1 2 3" while hiding a page."""
    assert page_window(5, 8) == [1, 2, 3, 4, 5, 6, 7, 8]


def test_short_ranges_list_every_page():
    assert page_window(1, 1) == [1]
    assert page_window(2, 3) == [1, 2, 3]
    assert page_window(3, 5) == [1, 2, 3, 4, 5]


def test_out_of_range_pages_clamp_to_the_real_ones():
    """A bookmark or a typed page number can outrun a corpus that shrank."""
    assert page_window(99, 5) == page_window(5, 5)
    assert page_window(0, 5) == page_window(1, 5)
    assert page_window(-3, 5) == page_window(1, 5)


def test_no_pages_no_window():
    assert page_window(1, 0) == []


def test_radius_controls_the_width():
    assert page_window(8, 16, radius=1) == [1, None, 7, 8, 9, None, 16]
    assert page_window(8, 16, radius=0) == [1, None, 8, None, 16]
