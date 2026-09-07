#!/bin/bash
# Собирает движок в самостоятельную папку (PyInstaller, onedir) для вложения в приложение:
# engine/dist/remarka-engine/remarka-engine — без системного Python и venv.
set -euo pipefail
cd "$(dirname "$0")"
PY=.venv/bin/python
uv pip install -q --python "$PY" "pyinstaller>=6.10"
rm -rf build dist
$PY -m PyInstaller --noconfirm --clean --onedir --name remarka-engine \
  --collect-all faster_whisper --collect-all ctranslate2 --collect-all onnxruntime \
  --collect-all parselmouth --collect-submodules scipy --collect-all soundfile \
  --collect-all anthropic --collect-all pydantic --collect-all tokenizers --collect-all huggingface_hub \
  --add-data "remarka_engine/data:remarka_engine/data" \
  --add-data "remarka_engine/prompts:remarka_engine/prompts" \
  --add-data "../docs/report.schema.json:docs" --add-data "../docs/baseline.schema.json:docs" \
  --add-data "../docs/patterns.schema.json:docs" --add-data "../docs/prep.schema.json:docs" \
  --hidden-import remarka_engine.cli --hidden-import remarka_engine.meaning --hidden-import remarka_engine.llm \
  --hidden-import remarka_engine.summary --hidden-import remarka_engine.patterns --hidden-import remarka_engine.prepare \
  --hidden-import remarka_engine.rescore \
  --paths . sidecar_main.py
du -sh dist/remarka-engine
echo "--- smoke: doctor"
dist/remarka-engine/remarka-engine doctor --asr-model small --llm none
