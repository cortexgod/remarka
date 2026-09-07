// Валидация mock‑отчёта по docs/report.schema.json (ajv, draft‑07) + проверки согласованности.
// Node ≥ 22.6 исполняет .ts напрямую (type stripping), поэтому генератор импортируется без сборки.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv from "ajv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { generateReport, transcriptText } = await import(path.join(root, "src/mock/report.ts"));
const { MEETING_SPECS } = await import(path.join(root, "src/mock/data.ts"));

const schema = JSON.parse(readFileSync(path.join(root, "docs/report.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const baseline = {
  schema_version: 1,
  created_at: "2026-08-26T12:15:00+03:00",
  meeting_ids: MEETING_SPECS.slice(0, 3).map((s) => s.id),
  stats: {
    "layer1.wpm": { mean: 127, std: 8.4, n: 3 },
    "layer1.filled_pauses_per_min": { mean: 1.6, std: 0.5, n: 3 },
    "layer1.crutch_words_per_min": { mean: 1.4, std: 0.4, n: 3 },
    "layer2.pitch_range_st": { mean: 4.6, std: 0.4, n: 3 },
    "layer2.jitter_pct": { mean: 1.0, std: 0.15, n: 3 },
  },
};

let failed = 0;
const fail = (msg) => {
  failed++;
  console.error("  ✗", msg);
};

for (const spec of MEETING_SPECS.filter((s) => s.status === "ready")) {
  const report = generateReport({
    id: spec.id,
    seed: spec.seed,
    started_at: "2026-09-04T14:30:00+03:00",
    duration_sec: spec.duration_sec,
    type: spec.type,
    type_source: spec.type_source,
    title: spec.title,
    has_system_track: spec.has_system_track,
    training_task_id: spec.training_task_id ?? null,
    baseline: spec.type === "pitch" ? baseline : null,
    calibrating_used: 2,
    layer2: spec.layer2,
    scenario: spec.scenario,
  });
  const ok = validate(report);
  const label = `${spec.type.padEnd(11)} ${String(spec.duration_sec).padStart(5)} с  words=${String(report.transcript.words.length).padStart(5)}  events=${String(report.events.length).padStart(4)}  score=${String(report.score.overall).padStart(3)}`;
  console.log((ok ? "✓ " : "✗ ") + label);
  if (!ok) {
    for (const e of validate.errors.slice(0, 10)) fail(`${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
  }
  // согласованность
  const text = transcriptText(report);
  for (const th of report.meaning?.three_things ?? []) {
    if (!text.includes(th.quote)) fail(`цитата не найдена в транскрипте: «${th.quote.slice(0, 50)}…»`);
  }
  const words = report.transcript.words;
  for (let i = 1; i < words.length; i++) if (words[i].start < words[i - 1].end - 1e-6) fail(`слова перекрываются: ${i}`);
  for (const w of words) if (w.i !== words.indexOf(w)) fail(`индекс слова ${w.i}`);
  for (const s of report.transcript.sentences) {
    if (words[s.word_from]?.sentence_i !== s.i || words[s.word_to]?.sentence_i !== s.i) fail(`границы предложения ${s.i}`);
  }
  for (const e of report.events) {
    if (e.word_i != null && !words[e.word_i]) fail(`событие ${e.kind} ссылается на слово ${e.word_i}`);
    if (e.end < e.t) fail(`событие ${e.kind}: end < t`);
  }
  if (report.meeting.type === "pitch") {
    const fp = report.events.filter((e) => e.kind === "filled_pause").length;
    const cluster = report.events.filter((e) => e.kind === "filled_pause" && e.t >= 851 && e.t < 1004).length;
    const early = report.timeline.wpm.filter((p) => p.t > 60 && p.t < 120).map((p) => p.v);
    console.log(`   заполненных пауз ${fp}, из них после первого вопроса ${cluster}; темп в первые 2 мин ${Math.min(...early)}–${Math.max(...early)}; вопросов ${report.meaning.questions.length}; база: ${report.baseline.status} (${report.baseline.deltas.length} дельт); basis=${report.score.basis}`);
    if (cluster < 8) fail("ожидалась гроздь заполненных пауз после первого вопроса");
    if (Math.max(...early) < 150) fail("ожидался темп 150+ в начале");
    if (report.meaning.three_things.length !== 3) fail("ожидалось три правки");
    if (report.metrics.layer1.talk_ratio.value == null) fail("talk_ratio должен быть посчитан");
  }
  const tw = report.timeline.wpm;
  if (tw[0].t !== 7.5 || tw[tw.length - 1].t + 7.5 > report.meeting.duration_sec + 1e-6) fail("окна таймлайна вне записи");
}

if (failed) {
  console.error(`\n${failed} проблем(ы)`);
  process.exit(1);
}
console.log("\nmock‑отчёты валидны по docs/report.schema.json");
