from conftest import words_from_text

from remarka_engine import crutches, segmenter


def _events(text: str, **kw):
    words = words_from_text(text, **kw)
    sents = segmenter.split_sentences(words)
    return words, crutches.detect_crutches(words, sents)


def test_bigram_and_trigram():
    words, ev = _events("Мы, как бы, делаем это на самом деле хорошо.")
    assert [e.label for e in ev] == ["как бы", "на самом деле"]
    assert words[1].kind == "crutch" and words[2].kind == "word"
    assert ev[0].t == words[1].start and ev[0].end == words[2].end
    assert ev[0].word_i == 1


def test_unconditional_unigrams():
    _, ev = _events("Это типа важно и собственно всё.")
    assert [e.label for e in ev] == ["типа", "собственно"]


def test_conditional_word_mid_sentence_not_counted():
    _, ev = _events("Я просто хочу сказать что вот это важно.")
    assert ev == []


def test_conditional_word_at_sentence_start_counted():
    _, ev = _events("Ну, я хочу сказать. Вот. Значит, идём дальше.")
    assert [e.label for e in ev] == ["ну", "вот", "значит"]


def test_conditional_word_with_pause_counted():
    _, ev = _events("Я хочу просто сказать это", gaps={2: 0.3})
    assert [e.label for e in ev] == ["просто"]
    _, ev2 = _events("Я хочу просто сказать это", gaps={3: 0.25})
    assert [e.label for e in ev2] == ["просто"]


def test_crutch_top_counts():
    _, ev = _events("Типа так. Типа сяк. Как бы да.")
    top = crutches.crutch_top(ev)
    assert top[0] == {"word": "типа", "count": 2} and top[1] == {"word": "как бы", "count": 1}
