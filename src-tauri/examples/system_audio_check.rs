//! Проверка захвата системного звука через capture/ (macOS: сайдкар remarka-tap).
//! Пишет N секунд (по умолчанию 3) и печатает заголовок WAV — или понятную ошибку (TCC и т. п.).
//!
//! cargo run --example system_audio_check -- 3

use remarka_lib::capture;
use std::time::Duration;

fn main() -> anyhow::Result<()> {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    let secs: f64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3.0);
    println!("system_audio_supported = {}", capture::supported());
    let out = std::env::temp_dir().join("remarka-system-check.wav");
    let mut cap = match capture::create() {
        Ok(c) => c,
        Err(e) => {
            println!("создать захват не удалось: {e}");
            return Ok(());
        }
    };
    if let Err(e) = cap.start(&out) {
        println!("старт не удался: {e:#}");
        return Ok(());
    }
    std::thread::sleep(Duration::from_secs_f64(secs));
    println!("уровень: {:?}", cap.level());
    let d = cap.stop()?;
    let r = hound::WavReader::open(&out)?;
    let spec = r.spec();
    println!(
        "WAV {}: {} Гц, {} кан., {} бит, {:.2} с (по событию stopped {:.2} с)",
        out.display(),
        spec.sample_rate,
        spec.channels,
        spec.bits_per_sample,
        r.len() as f64 / spec.sample_rate as f64,
        d
    );
    Ok(())
}
