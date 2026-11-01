# dsh-fish-draws

这是一个面向 DSH 的 Host + Web Client 组合包，通过固定、受控的 Qwen Image 2.1 ComfyUI 工作流提供文生图、单图编辑和多图编辑。它内嵌 `fish-draws` skill，并负责后台 job、精确尺寸、显存交接、技术重试、生命周期、唯一权威输出、清理和 DSH 原生设置页面。

> **署名说明：** 内置工作流和提示词参考由 **Zove-try** 分享的材料演化而来；作者已书面允许修改、通过 GitHub/npm 公开再分发及商业使用，并要求署名。原始来源及授权范围记录见 `THIRD_PARTY_NOTICES.md` 和 `assets/licensing/AUTHORIZATION.md`。

支持 Windows 10/11、本地 NVIDIA GPU、本地 ComfyUI，以及 DSH `>=0.2.1-rc.3 <0.3.0`。插件不会安装 ComfyUI、模型、自定义节点，也不接受任意节点图。ComfyUI 和 Strata 地址仅允许本机 loopback。

开发命令：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

`pnpm run release:check` 会在打包预览前执行类型、测试、构建、授权、路径和敏感信息检查。

配置 `comfy.root` 指向包含 `main.py` 的目录。输出默认进入 `<comfy.root>\output\fish-draws\日期\TaskId`，成功任务通常只留下最终 PNG 与 `result.json`。密钥由 DSH credentials 按引用解析，不进入配置、日志或结果文件。

## DSH 设置（3.1+）

在“设置 → 画图设置”中可以管理 ComfyUI、本地生图模型档案、Strata 认证和固定诊断：

- ComfyUI 仅允许 loopback API；手动停止只作用于当前 DSH Host 仍持有活 `ChildProcess` 句柄的插件自启实例。用户启动、身份不明或仅剩 PID 记录的实例必须回到原控制台关闭。
- 模型档案分别保存 T2I、单图编辑、多图编辑和 Fast 的安全范围及显存释放量。任务在 preflight 时截取快照，保存设置不会改变已提交任务。
- Strata 支持 `none` 和 `bearer`；密钥只通过 DSH credentials 单向写入，页面不会回显。
- “跑一轮”诊断只允许用户明确确认仅访问本机服务的 DSH route，固定生成 1024×1024、Balanced、1 张、20 步，并保存独立报告。

诊断图片和报告只保存在 `<OutputRoot>\fish-draws\diagnostics\<RunId>`，不会在普通任务目录重复保存。`promptExpansion.endpoint` 仅为 3.0 回滚兼容保留，3.1 不展示也不调用。

首次从 3.0 升级时，旧 `models + safety` 会迁移为“原有配置”档案并继续作为当前档案的兼容镜像。3.0 无法管理其他档案；若回滚期间 3.0 改动了镜像，再升级到 3.1 会把它导入为新的“3.0 回退配置”，不会覆盖现有档案。

首次 npm 发布必须由包所有者本人在本机使用 2FA 手动完成。Agent 不得代登录、接触 OTP/恢复码/token，也不得执行真实 `npm publish`；手动发布不能声称带 CI provenance。
