//! Прогон python-движка через engine.rs (без Tauri): doctor, затем analyze на фикстурах.
//!
//! cargo run --example engine_check -- [--asr-model small] [--llm none]

use remarka_lib::engine::{self, RunOptions};
use remarka_lib::models::{LlmBackend, Settings};
use std::time::{Duration, Instant};

fn main() -> anyhow::Result<()> {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
            .unwrap_or_else(|| default.to_string())
    };
    let asr_model = arg("--asr-model", "small");
    let llm = arg("--llm", "none");
    let settings = Settings {
        asr_model: asr_model.clone(),
        llm_backend: match llm.as_str() {
            "claude_cli" => LlmBackend::ClaudeCli,
            "anthropic_api" => LlmBackend::AnthropicApi,
            _ => LlmBackend::None,
        },
        ..Default::default()
    };

    let Some(launcher) = engine::find_launcher(&settings) else {
        anyhow::bail!("python движка не найден (engine/.venv/bin/python)");
    };
    println!("python: {}", launcher.python_display());
    let engine_dir = engine::dev_engine_dir().ok_or_else(|| anyhow::anyhow!("нет каталога engine/"))?;
    let fixtures = engine_dir.join("tests").join("fixtures");
    let out_dir = std::env::temp_dir().join("remarka-engine-check");
    std::fs::create_dir_all(&out_dir)?;

    // doctor
    let mut cmd = launcher.command(&settings, &out_dir);
    cmd.args(["doctor", "--asr-model", &asr_model, "--llm", settings.llm_backend.as_str()]);
    let outcome = engine::run_streaming(
        cmd,
        RunOptions { stderr_log: &out_dir.join("doctor.log"), append_log: false, timeout: Some(Duration::from_secs(180)), pid_slot: None },
        |ev| println!("  {ev:?}"),
    )?;
    println!("doctor: exit={:?} doctor_line={}", outcome.exit_code, outcome.doctor.is_some());

    // analyze
    let report = out_dir.join("report.json");
    let _ = std::fs::remove_file(&report);
    let mut cmd = launcher.command(&settings, &out_dir);
    cmd.arg("analyze")
        .arg("--mic")
        .arg(fixtures.join("me.wav"))
        .arg("--system")
        .arg(fixtures.join("other.wav"))
        .arg("--out")
        .arg(&report)
        .args([
            "--meeting-id",
            "00000000-0000-4000-8000-000000000001",
            "--started-at",
            &remarka_lib::util::now_iso(),
            "--asr-model",
            &asr_model,
            "--llm",
            settings.llm_backend.as_str(),
            "--llm-model",
            &settings.llm_model,
            "--compute-type",
            &settings.asr_compute_type,
            "--language",
            &settings.language,
        ]);
    let log = out_dir.join("engine.log");
    let t = Instant::now();
    let outcome = engine::run_streaming(
        cmd,
        RunOptions { stderr_log: &log, append_log: false, timeout: Some(Duration::from_secs(1800)), pid_slot: None },
        |ev| println!("  {ev:?}"),
    )?;
    println!(
        "analyze: exit={:?} done={:?} error={:?} за {:.1} с",
        outcome.exit_code,
        outcome.done_out,
        outcome.error,
        t.elapsed().as_secs_f64()
    );
    if !outcome.succeeded() {
        anyhow::bail!("{}", outcome.failure_message(&log));
    }
    let v = engine::read_json(&report)?;
    let s = engine::summarize_report(&v);
    println!("summary: {s:?}");
    let events = v.get("events").and_then(|e| e.as_array()).map(|a| a.len()).unwrap_or(0);
    println!("событий в отчёте: {events}; report.json: {}", report.display());
    Ok(())
}
