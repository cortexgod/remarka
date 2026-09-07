//! Мелкие общие помощники.

use std::sync::{Mutex, MutexGuard};

/// Текущее время как ISO-8601 с таймзоной, миллисекунды: `2026-09-07T10:00:00.000+03:00`.
pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// Захват мьютекса с восстановлением после паники в другом потоке.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Последние `n` строк текстового файла (для сообщений об ошибках движка).
pub fn tail_lines(path: &std::path::Path, n: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let lines: Vec<&str> = text.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_iso_has_timezone() {
        let s = now_iso();
        assert!(chrono::DateTime::parse_from_rfc3339(&s).is_ok(), "{s}");
    }
}
