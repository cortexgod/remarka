from conftest import raw_words, words_from_text

from remarka_engine import segmenter
from remarka_engine.fillers import mark_asr_fillers
from remarka_engine.spans import Span


def test_normalize_token():
    assert segmenter.normalize_token("Ёлка,") == "елка"
    assert segmenter.normalize_token("Э-э,") == "э-э"
    assert segmenter.normalize_token("юнит-экономика?") == "юнит-экономика"
    assert segmenter.normalize_token("«Привет»!") == "привет"
    assert segmenter.normalize_token("...") == ""


def test_build_words_glues_pure_punctuation():
    words = segmenter.build_words(raw_words([("Привет", 0, 0.3), ("...", 0.3, 0.4), ("мир.", 0.5, 0.8)]))
    assert [w.text for w in words] == ["Привет...", "мир."]
    assert words[0].end == 0.4


def test_sentences_by_punctuation_and_questions():
    words = words_from_text("Здравствуйте, коллеги. Как дела? Всё хорошо")
    sents = segmenter.split_sentences(words)
    assert [s.text for s in sents] == ["Здравствуйте, коллеги.", "Как дела?", "Всё хорошо"]
    assert [s.is_question for s in sents] == [False, True, False]
    assert [w.sentence_i for w in words] == [0, 0, 1, 1, 2, 2]
    assert sents[1].word_from == 2 and sents[1].word_to == 3 and sents[1].n_words == 2


def test_sentences_without_punctuation_split_on_pauses():
    words = words_from_text("раз два три четыре пять шесть", gaps={3: 1.0})
    sents = segmenter.split_sentences(words)
    assert [s.n_words for s in sents] == [3, 3]


def test_sentence_word_count_excludes_fillers():
    words = words_from_text("Э-э, сегодня м-м, я хочу.")
    sents = segmenter.split_sentences(words)
    mark_asr_fillers(words)
    segmenter.refresh_sentence_counts(words, sents)
    assert sents[0].n_words == 3


def test_pause_classification():
    # "слово," + 1.0 с → структурная; "слово" + 0.5 с → хезитационная; "слово" + 1.0 с → long; "слово," + 0.5 с → ничего
    words = words_from_text("первое, второе третье четвёртое, пятое шестое", gaps={1: 1.0, 2: 0.5, 3: 1.0, 4: 0.5, 5: 0.1})
    ev = segmenter.find_pauses(words)
    kinds = [(e.kind, e.label) for e in ev]
    assert kinds == [("structural_pause", "1,0 с"), ("hesitation_pause", "0,5 с"), ("hesitation_pause", "long")]
    assert ev[0].word_i == 1 and abs(ev[0].value - 1.0) < 1e-6
    assert ev[0].t == words[0].end and ev[0].end == words[1].start


def test_pause_overlapping_system_speech_is_ignored():
    words = words_from_text("первое, второе", gaps={1: 2.0})
    assert len(segmenter.find_pauses(words, [])) == 1
    assert segmenter.find_pauses(words, [Span(0.4, 2.0)]) == []


def test_filler_does_not_break_pause():
    words = words_from_text("первое э-э второе", gaps={1: 0.3, 2: 0.3})
    mark_asr_fillers(words)
    ev = segmenter.find_pauses(words)
    # между «первое» (0.3) и «второе» (0.3+0.3+0.3+0.3=1.2): пауза 0.9 без границы → long
    assert len(ev) == 1 and ev[0].kind == "hesitation_pause" and ev[0].label == "long"


def test_other_utterances_questions():
    raw = raw_words([("Скажите,", 0, 0.5), ("сколько", 0.6, 0.9), ("стоит", 1.0, 1.3), ("Понятно.", 3.0, 3.4), ("Хорошо", 3.5, 3.9)])
    utts = segmenter.split_other_utterances(raw)
    assert [u.text for u in utts] == ["Скажите, сколько стоит", "Понятно.", "Хорошо"]
    assert [u.is_question for u in utts] == [True, False, False]
    raw2 = raw_words([("А", 0, 0.1), ("чем", 0.2, 0.4), ("вы", 0.5, 0.6), ("лучше?", 0.7, 1.0)])
    assert segmenter.split_other_utterances(raw2)[0].is_question is True
