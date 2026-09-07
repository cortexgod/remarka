"""Точка входа для PyInstaller-сборки движка (абсолютный импорт, без relative import)."""
import multiprocessing
import os
import sys

from remarka_engine.cli import main

if __name__ == "__main__":
    # в замороженном приложении дочерние процессы multiprocessing запускают этот же бинарник
    multiprocessing.freeze_support()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    sys.exit(main())
