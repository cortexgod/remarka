//! Загрузка/сохранение `settings.json` (§2). Дефолты — `Settings::default()` в models.rs.

use crate::models::Settings;
use anyhow::{Context, Result};
use std::path::Path;

/// Читает настройки; если файла нет или он повреждён — возвращает дефолты
/// (недостающие поля тоже заполняются дефолтами через `#[serde(default)]`).
pub fn load(path: &Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("settings.json повреждён ({e}), используем дефолты");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(settings)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).context("не удалось записать settings.json")?;
    std::fs::rename(&tmp, path).context("не удалось заменить settings.json")?;
    Ok(())
}

/// Применяет частичный патч (объект с любым подмножеством полей `Settings`).
pub fn apply_patch(current: &Settings, patch: &serde_json::Value) -> Result<Settings> {
    let obj = patch
        .as_object()
        .context("патч настроек должен быть JSON-объектом")?;
    let mut merged = serde_json::to_value(current)?;
    let target = merged
        .as_object_mut()
        .context("внутренняя ошибка сериализации настроек")?;
    for (k, v) in obj {
        if !target.contains_key(k) {
            anyhow::bail!("неизвестное поле настроек: {k}");
        }
        target.insert(k.clone(), v.clone());
    }
    let settings: Settings =
        serde_json::from_value(merged).context("недопустимое значение в настройках")?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LlmBackend, Theme};

    #[test]
    fn roundtrip_and_patch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(load(&path), Settings::default());

        let patched = apply_patch(
            &Settings::default(),
            &serde_json::json!({"theme":"dark","llm_backend":"none","anthropic_api_key":"sk-x"}),
        )
        .unwrap();
        assert_eq!(patched.theme, Theme::Dark);
        assert_eq!(patched.llm_backend, LlmBackend::None);
        assert_eq!(patched.anthropic_api_key.as_deref(), Some("sk-x"));

        save(&path, &patched).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded, patched);

        assert!(apply_patch(&loaded, &serde_json::json!({"nope": 1})).is_err());
        assert!(apply_patch(&loaded, &serde_json::json!({"theme": "purple"})).is_err());
        assert!(apply_patch(&loaded, &serde_json::json!([1])).is_err());
    }

    #[test]
    fn broken_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
    }
}
