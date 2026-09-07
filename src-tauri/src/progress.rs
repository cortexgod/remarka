//! `get_progress`: серии по метрикам из report.json готовых встреч, серия дней,
//! сравнение месяцев, статус калибровки.

use crate::engine::BASELINE_MEETINGS_NEEDED;
use crate::models::{Baseline, BaselineComparison, ProgressData, ProgressSeriesPoint};
use crate::state::AppState;
use crate::util::lock;
use anyhow::Result;
use chrono::{DateTime, Datelike, Local, NaiveDate, Weekday};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const METRIC_KEYS: [&str; 19] = [
    "layer1.wpm",
    "layer1.articulation_wpm",
    "layer1.filled_pauses_per_min",
    "layer1.crutch_words_per_min",
    "layer1.hesitation_pauses_per_min",
    "layer1.structural_pauses_per_min",
    "layer1.talk_ratio",
    "layer1.mean_sentence_len",
    "layer1.long_sentences_share",
    "layer1.mtld",
    "layer1.interruptions_by_me",
    "layer2.pitch_median_hz",
    "layer2.pitch_range_st",
    "layer2.phrase_final_decay_db",
    "layer2.rising_statements_share",
    "layer2.jitter_pct",
    "layer2.shimmer_pct",
    "layer2.loudness_drift_db",
    "layer2.loudness_mean_db",
];

/// `report.metrics.<layer>.<name>.value` по ключу вида `layer1.wpm`.
pub fn metric_value(report: &Value, key: &str) -> Option<f64> {
    let (layer, name) = key.split_once('.')?;
    report
        .get("metrics")?
        .get(layer)?
        .get(name)?
        .get("value")?
        .as_f64()
}

/// Дней подряд с записью, считая только рабочие дни (выходные не рвут серию).
/// Если сегодня записи ещё нет — серия считается от вчера.
pub fn streak_days(dates: &HashSet<NaiveDate>, today: NaiveDate) -> u32 {
    let mut day = today;
    if !dates.contains(&day) {
        day = day.pred_opt().unwrap_or(day);
    }
    let mut streak = 0u32;
    for _ in 0..4000 {
        if matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
            match day.pred_opt() {
                Some(p) => day = p,
                None => break,
            }
            continue;
        }
        if dates.contains(&day) {
            streak += 1;
            match day.pred_opt() {
                Some(p) => day = p,
                None => break,
            }
        } else {
            break;
        }
    }
    streak
}

fn local_date(iso: &str) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.with_timezone(&Local).date_naive())
}

fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

pub fn baseline_comparison(baseline: Option<&Baseline>, ready_non_training: u32) -> BaselineComparison {
    match baseline {
        Some(b) => BaselineComparison {
            status: "ready".into(),
            meetings_used: b.meeting_ids.len() as u32,
            meetings_needed: BASELINE_MEETINGS_NEEDED,
            deltas: Vec::new(),
        },
        None => BaselineComparison {
            status: "calibrating".into(),
            meetings_used: ready_non_training.min(BASELINE_MEETINGS_NEEDED),
            meetings_needed: BASELINE_MEETINGS_NEEDED,
            deltas: Vec::new(),
        },
    }
}

pub fn build(state: &AppState) -> Result<ProgressData> {
    let (all_rows, ready_rows, ready_non_training) = {
        let db = lock(&state.db);
        (db.list()?, db.ready_rows()?, db.count_ready_non_training()?)
    };
    let paths = &state.paths;

    let mut series: BTreeMap<String, Vec<ProgressSeriesPoint>> = METRIC_KEYS
        .iter()
        .map(|k| (k.to_string(), Vec::new()))
        .collect();
    let mut score: Vec<ProgressSeriesPoint> = Vec::new();

    let today = Local::now().date_naive();
    let (this_y, this_m) = (today.year(), today.month());
    let (prev_y, prev_m) = if this_m == 1 {
        (this_y - 1, 12)
    } else {
        (this_y, this_m - 1)
    };
    let mut this_month_vals: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut prev_month_vals: BTreeMap<String, Vec<f64>> = BTreeMap::new();

    for row in &ready_rows {
        let path = paths.report_json(&row.id);
        let Ok(report) = crate::engine::read_json(&path) else {
            continue;
        };
        let date = local_date(&row.started_at);
        let bucket = match date {
            Some(d) if d.year() == this_y && d.month() == this_m => Some(&mut this_month_vals),
            Some(d) if d.year() == prev_y && d.month() == prev_m => Some(&mut prev_month_vals),
            _ => None,
        };
        let point = |value: f64| ProgressSeriesPoint {
            meeting_id: row.id.clone(),
            started_at: row.started_at.clone(),
            value,
            meeting_type: row.meeting_type,
        };
        let mut collected: Vec<(String, f64)> = Vec::new();
        for key in METRIC_KEYS {
            if let Some(v) = metric_value(&report, key) {
                series.get_mut(key).unwrap().push(point(v));
                collected.push((key.to_string(), v));
            }
        }
        let overall = report
            .get("score")
            .and_then(|s| s.get("overall"))
            .and_then(Value::as_f64)
            .or(row.score);
        if let Some(s) = overall {
            score.push(point(s));
            collected.push(("score".into(), s));
        }
        if let Some(b) = bucket {
            for (k, v) in collected {
                b.entry(k).or_default().push(v);
            }
        }
    }

    let keys_with_score: Vec<String> = METRIC_KEYS
        .iter()
        .map(|k| k.to_string())
        .chain(std::iter::once("score".to_string()))
        .collect();
    let this_month: BTreeMap<String, Option<f64>> = keys_with_score
        .iter()
        .map(|k| (k.clone(), this_month_vals.get(k).and_then(|v| mean(v))))
        .collect();
    let prev_month: BTreeMap<String, Option<f64>> = keys_with_score
        .iter()
        .map(|k| (k.clone(), prev_month_vals.get(k).and_then(|v| mean(v))))
        .collect();

    // серия дней: любая запись (тренировки тоже считаются днём с практикой)
    let dates: HashSet<NaiveDate> = all_rows
        .iter()
        .filter_map(|r| local_date(&r.started_at))
        .collect();

    let baseline: Option<Baseline> = crate::engine::read_optional_json(&paths.baseline_path())
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok());

    Ok(ProgressData {
        series,
        score,
        streak_days: streak_days(&dates, today),
        meetings_total: all_rows.len() as u32,
        this_month,
        prev_month,
        baseline: Some(baseline_comparison(baseline.as_ref(), ready_non_training)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn streak_skips_weekends() {
        // Пн 2026-09-07; записи в Чт 3, Пт 4, Пн 7
        let set: HashSet<NaiveDate> = ["2026-09-03", "2026-09-04", "2026-09-07"].iter().map(|s| d(s)).collect();
        assert_eq!(streak_days(&set, d("2026-09-07")), 3);
        // сегодня Вт 8 без записи → серия от вчера
        assert_eq!(streak_days(&set, d("2026-09-08")), 3);
        // сегодня Ср 9 без записи → вчера тоже пусто → 0
        assert_eq!(streak_days(&set, d("2026-09-09")), 0);
        // выходные не рвут: записи Пт 4 и Пн 7, сегодня Сб 12 (без записи, пропуск до Пт 11 — нет) → 0
        let set2: HashSet<NaiveDate> = ["2026-09-04", "2026-09-07"].iter().map(|s| d(s)).collect();
        assert_eq!(streak_days(&set2, d("2026-09-07")), 2);
        assert_eq!(streak_days(&set2, d("2026-09-08")), 2);
        assert!(streak_days(&HashSet::new(), d("2026-09-07")) == 0);
    }

    #[test]
    fn metric_value_by_key() {
        let r = serde_json::json!({"metrics": {"layer1": {"wpm": {"value": 120.5}, "talk_ratio": {"value": null}}, "layer2": {"pitch_range_st": {"value": 4.2}}}});
        assert_eq!(metric_value(&r, "layer1.wpm"), Some(120.5));
        assert_eq!(metric_value(&r, "layer1.talk_ratio"), None);
        assert_eq!(metric_value(&r, "layer2.pitch_range_st"), Some(4.2));
        assert_eq!(metric_value(&r, "layer2.nope"), None);
        assert_eq!(metric_value(&r, "nodot"), None);
    }

    #[test]
    fn calibration_status() {
        let c = baseline_comparison(None, 2);
        assert_eq!(c.status, "calibrating");
        assert_eq!(c.meetings_used, 2);
        assert_eq!(c.meetings_needed, 3);
        let b = Baseline { schema_version: 1, created_at: "x".into(), meeting_ids: vec!["a".into(), "b".into(), "c".into()], stats: Default::default() };
        let c = baseline_comparison(Some(&b), 7);
        assert_eq!(c.status, "ready");
        assert_eq!(c.meetings_used, 3);
    }
}
