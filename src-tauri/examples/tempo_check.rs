//! Калибровка живого темпа: прогоняет WAV (16 кГц моно) через TempoEstimator и печатает
//! оценку сл/мин каждые 5 с — для сравнения с timeline.wpm из report.json.
use remarka_lib::audio::tempo::TempoEstimator;

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("usage: tempo_check <mic.wav>");
    let mut reader = hound::WavReader::open(&path)?;
    let spec = reader.spec();
    let samples: Vec<f32> = reader.samples::<i16>().map(|s| s.map(|v| v as f32 / 32768.0)).collect::<Result<_, _>>()?;
    let mut est = TempoEstimator::new(spec.sample_rate);
    let chunk = (spec.sample_rate / 4) as usize;
    let mut t = 0.0f32;
    for c in samples.chunks(chunk) {
        est.push(c);
        t += c.len() as f32 / spec.sample_rate as f32;
        if ((t * 4.0).round() as i64) % 20 == 0 {
            match (est.syllables_per_sec(), est.wpm_estimate()) {
                (Some(s), Some(w)) => println!("{t:6.1}s  syl/s {s:5.2}  wpm {w:6.1}"),
                _ => println!("{t:6.1}s  —"),
            }
        }
    }
    Ok(())
}
