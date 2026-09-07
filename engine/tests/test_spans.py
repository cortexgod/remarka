from remarka_engine.spans import Span, intersect, merge_gaps, normalize, subtract, total


def test_normalize_merges_overlaps():
    s = normalize([Span(2, 3), Span(0, 1), Span(0.5, 1.5), Span(5, 5)])
    assert s == [Span(0, 1.5), Span(2, 3)]


def test_intersect_and_subtract():
    a = [Span(0, 10)]
    b = [Span(2, 4), Span(8, 12)]
    assert intersect(a, b) == [Span(2, 4), Span(8, 10)]
    assert subtract(a, b) == [Span(0, 2), Span(4, 8)]
    assert total(subtract(a, b)) == 6


def test_merge_gaps():
    assert merge_gaps([Span(0, 1), Span(1.3, 2), Span(3, 4)], 0.5) == [Span(0, 2), Span(3, 4)]
