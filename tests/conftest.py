import sys
from pathlib import Path

# 让 `pytest tests/test_extract.py` 在任何 CWD 下都能 import byk
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
