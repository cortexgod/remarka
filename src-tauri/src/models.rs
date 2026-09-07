//! Serde-типы, зеркалящие `src/types/contracts.ts`. Все JSON-поля — snake_case.

use serde::{Deserialize, Serialize};
use std::fmt;

// ---------------------------------------------------------------------------
// Общие перечисления
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MeetingType {
    Pitch,
    Demo,
    Sales,
    Interview,
    Standup,
    Lecture,
    OneOnOne,
    Training,
    #[default]
    Other,
}

impl MeetingType {
    pub fn as_str(&self) -> &'static str {
        match self {
            MeetingType::Pitch => "pitch",
            MeetingType::Demo => "demo",
            MeetingType::Sales => "sales",
            MeetingType::Interview => "interview",
            MeetingType::Standup => "standup",
            MeetingType::Lecture => "lecture",
            MeetingType::OneOnOne => "one_on_one",
            MeetingType::Training => "training",
            MeetingType::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pitch" => MeetingType::Pitch,
            "demo" => MeetingType::Demo,
            "sales" => MeetingType::Sales,
            "interview" => MeetingType::Interview,
            "standup" => MeetingType::Standup,
            "lecture" => MeetingType::Lecture,
            "one_on_one" => MeetingType::OneOnOne,
            "training" => MeetingType::Training,
            "other" => MeetingType::Other,
            _ => return None,
        })
    }
}

impl fmt::Display for MeetingType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStatus {
    Recording,
    Recorded,
    Analyzing,
    Ready,
    Error,
}

impl MeetingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MeetingStatus::Recording => "recording",
            MeetingStatus::Recorded => "recorded",
            MeetingStatus::Analyzing => "analyzing",
            MeetingStatus::Ready => "ready",
            MeetingStatus::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "recording" => MeetingStatus::Recording,
            "recorded" => MeetingStatus::Recorded,
            "analyzing" => MeetingStatus::Analyzing,
            "ready" => MeetingStatus::Ready,
            "error" => MeetingStatus::Error,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TypeSource {
    Llm,
    User,
    #[default]
    Default,
}

impl TypeSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            TypeSource::Llm => "llm",
            TypeSource::User => "user",
            TypeSource::Default => "default",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "llm" => TypeSource::Llm,
            "user" => TypeSource::User,
            "default" => TypeSource::Default,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LlmBackend {
    ClaudeCli,
    AnthropicApi,
    #[default]
    None,
}

impl LlmBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            LlmBackend::ClaudeCli => "claude_cli",
            LlmBackend::AnthropicApi => "anthropic_api",
            LlmBackend::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

// ---------------------------------------------------------------------------
// Оболочка ↔ фронтенд
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingCard {
    pub id: String,
    pub started_at: String,
    pub duration_sec: f64,
    pub meeting_type: MeetingType,
    pub type_source: TypeSource,
    pub title: Option<String>,
    pub status: MeetingStatus,
    pub score: Option<f64>,
    pub prev_score: Option<f64>,
    pub has_system_track: bool,
    pub training_task_id: Option<String>,
    pub error: Option<String>,
    pub wpm: Option<f64>,
    pub filled_pauses_per_min: Option<f64>,
    pub talk_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingState {
    pub meeting_id: String,
    pub started_at: String,
    pub elapsed_sec: f64,
    pub system_audio: bool,
    pub level_db: f32,
    pub system_level_db: Option<f32>,
    pub wpm_estimate: Option<f32>,
}

/// `AppState` из contracts.ts (в Rust runtime-состояние называется иначе, см. state.rs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppStateInfo {
    pub recording: Option<RecordingState>,
    pub analyzing: Vec<String>,
    pub engine_ok: bool,
    pub platform: String,
    pub system_audio_supported: bool,
    pub meeting_app_running: Option<String>,
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub system_audio_default: bool,
    pub auto_analyze: bool,
    pub asr_model: String,
    pub asr_compute_type: String,
    pub llm_backend: LlmBackend,
    pub llm_model: String,
    pub anthropic_api_key: Option<String>,
    /// Путь к claude или к SSH-обёртке (scripts/claude-ssh): слой смысла на другой машине.
    pub llm_cli_path: Option<String>,
    pub language: String,
    pub input_device: Option<String>,
    pub engine_python: Option<String>,
    pub show_overlay: bool,
    pub ask_on_meeting_app: bool,
    pub theme: Theme,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            system_audio_default: false,
            auto_analyze: true,
            asr_model: "large-v3-turbo".to_string(),
            asr_compute_type: "int8".to_string(),
            llm_backend: LlmBackend::ClaudeCli,
            llm_model: "claude-opus-5".to_string(),
            anthropic_api_key: None,
            llm_cli_path: None,
            language: "ru".to_string(),
            input_device: None,
            engine_python: None,
            show_overlay: true,
            ask_on_meeting_app: true,
            theme: Theme::System,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineDoctor {
    pub ok: bool,
    pub python: Option<String>,
    pub engine_version: Option<String>,
    pub asr_model_cached: bool,
    pub llm_backend_available: bool,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressSeriesPoint {
    pub meeting_id: String,
    pub started_at: String,
    pub value: f64,
    pub meeting_type: MeetingType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineDelta {
    pub metric: String,
    pub baseline: f64,
    pub value: f64,
    pub delta: f64,
    pub z: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineComparison {
    pub status: String, // "calibrating" | "ready"
    pub meetings_used: u32,
    pub meetings_needed: u32,
    pub deltas: Vec<BaselineDelta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineStat {
    pub mean: f64,
    pub std: f64,
    pub n: u32,
}

/// Файл baseline.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Baseline {
    pub schema_version: u32,
    pub created_at: String,
    pub meeting_ids: Vec<String>,
    pub stats: std::collections::BTreeMap<String, BaselineStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressData {
    pub series: std::collections::BTreeMap<String, Vec<ProgressSeriesPoint>>,
    pub score: Vec<ProgressSeriesPoint>,
    pub streak_days: u32,
    pub meetings_total: u32,
    pub this_month: std::collections::BTreeMap<String, Option<f64>>,
    pub prev_month: std::collections::BTreeMap<String, Option<f64>>,
    pub baseline: Option<BaselineComparison>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingTask {
    pub id: String,
    pub title: String,
    pub instruction: String,
    pub duration_sec: f64,
    pub targets_metric: Option<String>,
    pub meeting_type: MeetingType,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StartRecordingOpts {
    pub system_audio: bool,
    pub title: Option<String>,
    pub meeting_type: Option<MeetingType>,
    pub training_task_id: Option<String>,
    pub input_device: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportAudioOpts {
    pub mic_path: String,
    #[serde(default)]
    pub system_path: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub meeting_type: Option<MeetingType>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingIdResponse {
    pub meeting_id: String,
}

// ---------------------------------------------------------------------------
// События (tauri `listen`)
// ---------------------------------------------------------------------------

pub mod events {
    pub const RECORDING_STARTED: &str = "recording:started";
    pub const RECORDING_TICK: &str = "recording:tick";
    pub const RECORDING_STOPPED: &str = "recording:stopped";
    pub const ANALYSIS_PROGRESS: &str = "analysis:progress";
    pub const ANALYSIS_DONE: &str = "analysis:done";
    pub const ANALYSIS_ERROR: &str = "analysis:error";
    pub const MEETING_APP: &str = "meeting-app:changed";
    pub const MEETINGS_CHANGED: &str = "meetings:changed";
    pub const SETTINGS_CHANGED: &str = "settings:changed";
    pub const RECORDING_WARNING: &str = "recording:warning";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvRecordingStarted {
    pub meeting_id: String,
    pub started_at: String,
    pub system_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvRecordingTick {
    pub meeting_id: String,
    pub elapsed_sec: f64,
    pub level_db: f32,
    pub system_level_db: Option<f32>,
    pub wpm_estimate: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvRecordingStopped {
    pub meeting_id: String,
    pub duration_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvAnalysisProgress {
    pub meeting_id: String,
    pub stage: String,
    pub pct: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvAnalysisDone {
    pub meeting_id: String,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvAnalysisError {
    pub meeting_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvMeetingApp {
    pub app: Option<String>,
}

// ---------------------------------------------------------------------------
// Протокол движка (stdout, JSON lines)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Progress {
        stage: String,
        pct: f64,
        message: String,
    },
    Log {
        level: String,
        message: String,
    },
    Done {
        out: String,
    },
    Error {
        message: String,
        stage: Option<String>,
    },
    /// `doctor` отдаёт одну строку `{"event":"doctor", ...}`; сохраняем как есть.
    Doctor(serde_json::Value),
    /// Неизвестное событие — тип и сырой JSON.
    Other(String, serde_json::Value),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_serialize_snake_case() {
        assert_eq!(serde_json::to_string(&MeetingType::OneOnOne).unwrap(), "\"one_on_one\"");
        assert_eq!(serde_json::to_string(&LlmBackend::ClaudeCli).unwrap(), "\"claude_cli\"");
        assert_eq!(serde_json::to_string(&TypeSource::Default).unwrap(), "\"default\"");
        assert_eq!(
            serde_json::from_str::<MeetingStatus>("\"analyzing\"").unwrap(),
            MeetingStatus::Analyzing
        );
        for t in [
            MeetingType::Pitch,
            MeetingType::Demo,
            MeetingType::Sales,
            MeetingType::Interview,
            MeetingType::Standup,
            MeetingType::Lecture,
            MeetingType::OneOnOne,
            MeetingType::Training,
            MeetingType::Other,
        ] {
            assert_eq!(MeetingType::parse(t.as_str()), Some(t));
            assert_eq!(serde_json::to_string(&t).unwrap(), format!("\"{}\"", t.as_str()));
        }
    }

    #[test]
    fn settings_defaults_fill_missing_fields() {
        let s: Settings = serde_json::from_str(r#"{"asr_model":"small","theme":"dark"}"#).unwrap();
        assert_eq!(s.asr_model, "small");
        assert_eq!(s.theme, Theme::Dark);
        assert!(!s.system_audio_default);
        assert!(s.auto_analyze);
        assert_eq!(s.llm_model, "claude-opus-5");
    }

    #[test]
    fn start_opts_accept_partial_object() {
        let o: StartRecordingOpts = serde_json::from_str(r#"{"system_audio":true}"#).unwrap();
        assert!(o.system_audio);
        assert!(o.meeting_type.is_none());
        let o: StartRecordingOpts =
            serde_json::from_str(r#"{"system_audio":false,"meeting_type":"pitch","title":null}"#).unwrap();
        assert_eq!(o.meeting_type, Some(MeetingType::Pitch));
    }
}

/// Предупреждение во время записи (микрофон отключился, системная дорожка оборвалась, автостоп).
#[derive(Debug, Clone, serde::Serialize)]
pub struct EvRecordingWarning {
    pub meeting_id: String,
    pub message: String,
}
