# AI 小队 · 源码安装包

解压后，优先查看包内的 `docs/SETUP.md`。只在 Windows 本机运行角色时，准备好 Node.js 和所选 Agent 后，双击根目录中的 `ai-team.cmd`。

需要搭建托管 VPS 和 Windows-MCP 时，使用 `setup-relay-desk.cmd`。添加现有 SSH 位置、本机及远程目录的操作见 `docs/Relay-Desk-Workbench.md`。需要排障时查阅 `docs/ADVANCED.md`。

在没有运行安装操作的情况下，可用以下命令查看计划：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-RelayDesk.ps1 -Plan
```
