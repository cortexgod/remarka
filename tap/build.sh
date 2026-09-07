#!/bin/bash
# Сборка сайдкара remarka-tap через swiftc напрямую (без SwiftPM):
#   arm64 (обязательно) → src-tauri/binaries/remarka-tap-aarch64-apple-darwin
#   x86_64 (если тулчейн умеет) → src-tauri/binaries/remarka-tap-x86_64-apple-darwin
#   + универсальный бинарник (lipo) в tap/.build/remarka-tap-universal для ручных проверок.
# Tauri требует по одному чистому срезу на target triple, поэтому в binaries/ кладём не универсальный,
# а по-архитектурные файлы.
#
# Переменные: NO_X86=1 — не пытаться собрать x86_64; SWIFTC=/path/swiftc — другой компилятор.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$ROOT/src-tauri/binaries"
BUILD="$HERE/.build/swiftc"
SWIFTC="${SWIFTC:-swiftc}"
MIN_MACOS="14.4"
SRCS=("$HERE"/Sources/remarka-tap/*.swift)

mkdir -p "$OUT_DIR" "$BUILD"

COMMON=(
  -O
  -swift-version 5
  -module-name remarka_tap
  -framework CoreAudio
  -framework Foundation
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/Info.plist"
)

build_slice() {
  local target="$1" out="$2"
  "$SWIFTC" "${COMMON[@]}" -target "$target" "${SRCS[@]}" -o "$out"
}

echo "[build.sh] swiftc: $("$SWIFTC" --version 2>&1 | head -1)"
echo "[build.sh] arm64 → $BUILD/remarka-tap-arm64"
build_slice "arm64-apple-macos${MIN_MACOS}" "$BUILD/remarka-tap-arm64"

HAVE_X86=0
if [[ "${NO_X86:-0}" != "1" ]]; then
  echo "[build.sh] x86_64 → $BUILD/remarka-tap-x86_64 (попытка)"
  if build_slice "x86_64-apple-macos${MIN_MACOS}" "$BUILD/remarka-tap-x86_64" 2>"$BUILD/x86_64.log"; then
    HAVE_X86=1
  else
    echo "[build.sh] x86_64 не собрался (см. $BUILD/x86_64.log) — оставляем только arm64"
  fi
fi

if [[ "$HAVE_X86" == "1" ]]; then
  lipo -create "$BUILD/remarka-tap-arm64" "$BUILD/remarka-tap-x86_64" -output "$BUILD/remarka-tap-universal"
  echo "[build.sh] universal → $BUILD/remarka-tap-universal ($(lipo -archs "$BUILD/remarka-tap-universal"))"
fi

sign() {
  # Ad-hoc подпись со стабильным идентификатором: TCC различает клиентов по подписи.
  codesign --force --sign - --identifier com.remarka.app.tap "$1" 2>/dev/null || true
}

cp "$BUILD/remarka-tap-arm64" "$OUT_DIR/remarka-tap-aarch64-apple-darwin"
sign "$OUT_DIR/remarka-tap-aarch64-apple-darwin"
if [[ "$HAVE_X86" == "1" ]]; then
  cp "$BUILD/remarka-tap-x86_64" "$OUT_DIR/remarka-tap-x86_64-apple-darwin"
  sign "$OUT_DIR/remarka-tap-x86_64-apple-darwin"
  sign "$BUILD/remarka-tap-universal"
fi

echo "[build.sh] готово:"
ls -la "$OUT_DIR"/remarka-tap-* | sed 's/^/  /'
for f in "$OUT_DIR"/remarka-tap-*; do echo "  $(lipo -archs "$f")  $f"; done
