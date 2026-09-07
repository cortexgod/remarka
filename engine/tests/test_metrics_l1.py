from conftest import words_from_text

from remarka_engine import metrics_l1, segmenter, timeline
from remarka_engine.model import SpeechEvent
from remarka_engine.spans import Span


def test_mtld_basic_properties():
    assert metrics_l1.mtld(["a"] * 40) is None
    same = metrics_l1.mtld(["слово"] * 60)
    assert same is not None and same < 5
    unique = metrics_l1.mtld([f"w{i}" for i in range(60)])
    assert unique is not None and unique >= 60
    mixed = metrics_l1.mtld([f"w{i % 10}" for i in range(100)])
    assert mixed is not None and 5 < mixed < 60


def test_interruptions():
    mine = [Span(0, 5)]
    other = [Span(3, 6)]
    ev = metrics_l1.interruptions(mine, other)
    assert [e.kind for e in ev] == ["interruption_by_other"]
    assert ev[0].t == 3 and ev[0].end == 5 and abs(ev[0].value - 2.0) < 1e-9
    assert metrics_l1.interruptions([Span(0, 5)], [Span(4.8, 6)]) == []  # пересечение < 0,5 с
    assert metrics_l1.interruptions([Span(0.5, 3)], [Span(0, 5)]) == []  # первый говорил < 1 с
    assert [e.kind for e in metrics_l1.interruptions([Span(2, 6)], [Span(0, 5)])] == ["interruption_by_me"]
    assert metrics_l1.interruptions([], [Span(0, 5)]) == []


def test_active_seconds_excludes_other_only():
    mic = [Span(0, 10), Span(20, 30)]
    system = [Span(10, 20), Span(25, 40)]
    # 0–30 = 30 с, минус «только собеседник» 10–20 = 20 с
    assert abs(metrics_l1.active_seconds(mic, system) - 20.0) < 1e-9
    assert metrics_l1.active_seconds([], system) == 0.0


def test_layer1_compute_with_system_track():
    text = " ".join(["слово"] * 30) + "."
    words = words_from_text(text, word_dur=0.3, gap=0.2)  # 30 слов за 15 с
    sents = segmenter.split_sentences(words)
    mic = [Span(0, 14.8)]
    system = [Span(20, 30)]
    tl = timeline.build(words, mic, system, 30.0, None, 130)
    events = [
        SpeechEvent(t=1, end=1.2, kind="filled_pause", label="э-э", source="asr"),
        SpeechEvent(t=2, end=2.3, kind="crutch", label="типа", source="asr"),
        SpeechEvent(t=3, end=3.5, kind="hesitation_pause", label="0,5 с", source="asr", value=0.5),
    ]
    inp = metrics_l1.Layer1Inputs(words=words, sentences=sents, events=events, mic_speech=mic, system_speech=system, has_system=True, duration_sec=30.0, timeline=tl)
    m, top = metrics_l1.compute(inp, "sales")
    assert m["words_total"].value == 30
    assert abs(m["talk_ratio"].value - 14.8 / 24.8) < 1e-6
    assert m["talk_ratio"].status == "bad"  # 0.6 при ориентире 0.40–0.45 для sales
    # окна 0–15 / 5–20 / 10–25 дают 120 / 80 / 40 сл/мин (тишина в окне входит в темп) → медиана 80
    assert abs(m["wpm"].value - 80.0) < 1e-6
    assert m["articulation_wpm"].value > m["wpm"].value
    assert m["filled_pauses_total"].value == 1 and m["crutch_words_total"].value == 1
    assert abs(m["filled_pauses_per_min"].value - 60 / 14.8) < 1e-6
    assert m["mean_sentence_len"].value == 30 and m["long_sentences_share"].value == 1.0
    assert m["mtld"].value is None  # 30 < 50 слов
    assert m["interruptions_by_me"].value == 0
    assert m["my_speech_sec"].value == 14.8 and m["other_speech_sec"].value == 10
    assert top == [{"word": "типа", "count": 1}]


def test_layer1_without_system_track():
    words = words_from_text("Привет мир.")
    sents = segmenter.split_sentences(words)
    inp = metrics_l1.Layer1Inputs(words=words, sentences=sents, events=[], mic_speech=[Span(0, 0.7)], system_speech=[], has_system=False, duration_sec=1.0)
    m, _ = metrics_l1.compute(inp, "other")
    assert m["talk_ratio"].value is None and m["talk_ratio"].status == "na"
    assert m["interruptions_by_me"].value is None
    assert m["other_speech_sec"].value is None


def test_layer1_empty():
    inp = metrics_l1.Layer1Inputs(words=[], sentences=[], events=[], mic_speech=[], system_speech=[], has_system=False, duration_sec=0.0)
    m, top = metrics_l1.compute(inp, "pitch")
    assert all(v.value is None for k, v in m.items() if k not in ("my_speech_sec", "words_total"))
    assert m["words_total"].value == 0 and top == []
