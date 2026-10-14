"""``python -m byk`` 启动本地服务。"""
from __future__ import annotations

import argparse

from .server import main

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="BYK 多智能体系统")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8760)
    args = ap.parse_args()
    main(args.host, args.port)
