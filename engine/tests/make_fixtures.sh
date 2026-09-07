#!/usr/bin/env bash
# Регенерация фикстур tests/fixtures/{me,other}.wav (48 с, 16 кГц, моно, int16)
# через macOS `say -v Milena` + ffmpeg. Паузы — [[slnc N]] (мс).
#
#   tests/make_fixtures.sh            → пишет в tests/fixtures/
#   tests/make_fixtures.sh /tmp/out   → пишет в указанный каталог
set -euo pipefail

OUT_DIR="${1:-$(cd "$(dirname "$0")" && pwd)/fixtures}"
VOICE="${VOICE:-Milena}"
DURATION=48
mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v say >/dev/null || { echo "нужен macOS say" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "нужен ffmpeg" >&2; exit 1; }

# «Я»: филлеры («э-э», «м-м»), костыли («как бы», «типа», «на самом деле», «вот», «собственно»), паузы.
ME_TEXT='Здравствуйте, коллеги. [[slnc 700]] Э-э, [[slnc 200]] сегодня я хочу рассказать про наш продукт. [[slnc 500]] Мы, как бы, делаем приложение, [[slnc 300]] которое, э-э, [[slnc 200]] слушает созвоны и м-м, [[slnc 150]] анализирует речь. [[slnc 900]] Типа, оно считает темп речи, паузы и слова-паразиты. [[slnc 700]] На самом деле, рынок здесь, э-э, [[slnc 200]] очень большой. [[slnc 1000]] Первые три встречи бесплатно, дальше подписка. [[slnc 600]] Вот. [[slnc 700]] Но, собственно, [[slnc 500]] на этом всё, готов ответить на вопросы.'

# «Собеседник»: два вопроса — про юнит-экономику (~21 с) и про отличие от конкурентов (~43 с).
OTHER_TEXT='[[slnc 21000]] Скажите, а какая у вас юнит-экономика? [[slnc 16000]] Понятно, а чем вы отличаетесь от конкурентов?'

render() {
  local text="$1" out="$2"
  say -v "$VOICE" -r 175 -o "$TMP/tts.aiff" "$text"
  # → 16 кГц моно PCM16, дополнить тишиной и обрезать до ровно $DURATION с
  ffmpeg -loglevel error -y -i "$TMP/tts.aiff" -ac 1 -ar 16000 -sample_fmt s16 \
    -af "apad=whole_dur=${DURATION},atrim=0:${DURATION}" "$out"
  echo "$out"
}

render "$ME_TEXT" "$OUT_DIR/me.wav"
render "$OTHER_TEXT" "$OUT_DIR/other.wav"

for f in "$OUT_DIR/me.wav" "$OUT_DIR/other.wav"; do
  ffprobe -loglevel error -show_entries stream=sample_rate,channels,duration -of compact "$f"
done
