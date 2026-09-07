//! Интеграционная проверка микрофона: пишет N секунд (по умолчанию 3) в WAV
//! и проверяет заголовок (16 кГц, моно, 16 бит) и длительность.
//!
//! cargo run --example record_check -- 3

use std::time::Duration;

fn main() -> anyhow::Result<()> {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    let secs: f64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3.0);
    let out = std::env::temp_dir().join("remarka-record-check.wav");

    println!("Устройства ввода:");
    for d in remarka_lib::audio::mic::list_devices()? {
        println!(
            "  {}{}  [{}]",
            d.name,
            if d.is_default { " (по умолчанию)" } else { "" },
            d.id
        );
    }

    let handle = remarka_lib::audio::mic::start(
        None,
        &out,
        Box::new(|t| {
            println!(
                "tick {:5.2} с  уровень {:6.1} дБFS  темп {}",
                t.elapsed_sec,
                t.level_db,
                t.wpm_estimate
                    .map(|w| format!("{w:.0} сл/мин"))
                    .unwrap_or_else(|| "—".into())
            )
        }),
        Duration::from_millis(250),
    )?;
    std::thread::sleep(Duration::from_secs_f64(secs));
    let counted = handle.stop()?;

    let mut reader = hound::WavReader::open(&out)?;
    let spec = reader.spec();
    let n = reader.len();
    let header_dur = n as f64 / spec.sample_rate as f64 / spec.channels as f64;
    let peak = reader
        .samples::<i16>()
        .filter_map(Result::ok)
        .map(|s| (s as i32).abs())
        .max()
        .unwrap_or(0);
    println!(
        "WAV: {}\n  {} Гц, {} кан., {} бит, {} сэмплов → {:.2} с по заголовку, {:.2} с по счётчику",
        out.display(),
        spec.sample_rate,
        spec.channels,
        spec.bits_per_sample,
        n,
        header_dur,
        counted
    );
    println!(
        "  пик: {} ({:.1} дБFS)",
        peak,
        20.0 * (peak.max(1) as f64 / 32768.0).log10()
    );
    anyhow::ensure!(
        spec.sample_rate == 16000 && spec.channels == 1 && spec.bits_per_sample == 16,
        "неверный формат WAV"
    );
    anyhow::ensure!(
        (header_dur - secs).abs() < 0.6,
        "длительность {header_dur:.2} с не совпадает с ожидаемой {secs} с"
    );
    if peak == 0 {
        println!("ВНИМАНИЕ: сигнал нулевой — вероятно, нет доступа к микрофону (TCC) или он выключен");
    }
    println!("OK");
    Ok(())
}
