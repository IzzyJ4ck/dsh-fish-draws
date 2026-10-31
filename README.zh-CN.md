# dsh-fish-draws

这是一个面向 DSH 的 Host 组合包，通过固定、受控的 Qwen Image 2.1 ComfyUI 工作流提供文生图、单图编辑和多图编辑。它内嵌 `fish-draws` skill，并负责后台 job、精确尺寸、显存交接、技术重试、生命周期、唯一权威输出和清理。

> **署名说明：** 内置工作流和提示词参考由 **Zove-try** 分享的材料演化而来；作者已书面允许修改、通过 GitHub/npm 公开再分发及商业使用，并要求署名。原始来源及授权范围记录见 `THIRD_PARTY_NOTICES.md` 和 `assets/licensing/AUTHORIZATION.md`。

支持 Windows 10/11、本地 NVIDIA GPU、本地 ComfyUI，以及 DSH `>=0.2.1-rc.3 <0.3.0`。插件不会安装 ComfyUI、模型、自定义节点，也不接受任意节点图。ComfyUI 和 Strata 地址仅允许本机 loopback。

开发命令：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

在版权门未解除前，`pnpm run release:check` 应明确失败，从而阻止误发 npm。

配置 `comfy.root` 指向包含 `main.py` 的目录。输出默认进入 `<comfy.root>\output\fish-draws\日期\TaskId`，成功任务通常只留下最终 PNG 与 `result.json`。密钥由 DSH credentials 按引用解析，不进入配置、日志或结果文件。

首次 npm 发布必须由包所有者本人在本机使用 2FA 手动完成。Agent 不得代登录、接触 OTP/恢复码/token，也不得执行真实 `npm publish`；手动发布不能声称带 CI provenance。
