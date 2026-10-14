"""BYK — 多智能体协作框架。

结构：
- ``byk.orchestrator`` —— 主对话（编排器），负责与用户交互、拆解、派发、汇总。
- ``byk.dsh_runner``   —— 把一次助手调用落地为一个无头 DSH 智能体进程。
- ``byk.roles``        —— 七个助手的人格定义与模型分工。
- ``byk.precedents``   —— 提权先例库与本地密钥库。
- ``byk.extract``      —— 本地内容提取层：把任意文件变成「文本 + 元数据」，不调用 LLM。

为使子包可独立导入，这里刻意不预先导入 orchestrator / server 等重模块。
"""

from __future__ import annotations

__version__ = "1.0.0"

__all__ = ["__version__"]
