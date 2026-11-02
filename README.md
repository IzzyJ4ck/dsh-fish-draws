# fish-draws

[English](./README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/%40izzyj4ck%2Fdsh-fish-draws?label=npm)](https://www.npmjs.com/package/@izzyj4ck/dsh-fish-draws)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3%20%3C0.3.0-5B5BD6)

让 DSH 中负责理解需求的模型，安全调用本机的 Qwen Image 2.1 与 ComfyUI，完成文生图、单图编辑和多图编辑。

`fish-draws` 不是另一个隐藏的生图网站，也不会在后台调用额外的 LLM。当前 DSH 会话模型负责理解用户要求、观察参考图、扩写提示词和检查结果；插件负责尺寸解析、显存交接、ComfyUI 工作流、失败恢复、图片回传和文件清理；真正的图像生成始终发生在本机。

```text
用户要求
   ↓
DSH 当前会话模型
理解任务、观察参考图、扩写提示词
   ↓
fish-draws
尺寸解析、显存交接、任务与生命周期管理
   ↓
本机 ComfyUI + Qwen Image 2.1
   ↓
图片、扩写提示词与 result.json 返回 DSH
```

## 适合哪些用户

适合：

- 已经部署本地 ComfyUI 和 Qwen Image 2.1，希望直接在 DSH 对话中生图或改图；
- 使用 DeepSeek 官方模型规划任务，但希望图片只在自己的电脑上生成；
- 使用 Strata/Qwen 等本地模型，希望做到“本地 LLM + 本地生图”；
- 一张 GPU 同时承载本地 LLM 和生图模型，需要自动交接显存；
- 需要多图职责规划、精确输出尺寸、批量抽卡、技术重试和可追溯结果。

暂不适合：

- 希望插件自动安装 ComfyUI、模型或任意第三方节点；
- 使用 macOS、Linux、AMD GPU 或远程 ComfyUI；
- 希望直接导入任意第三方 ComfyUI 工作流；
- 希望用外部脚本偷偷修改最终图片。

## 两种典型使用方式

| 方式 | DSH 中负责规划的模型 | 实际生图模型 | 特点 |
|---|---|---|---|
| DeepSeek 官方模型 + 本地生图 | DeepSeek 云端 API | 本机 Qwen Image 2.1 | 配置简单，语言模型不占本机显存；提示词会发送给 DeepSeek API |
| 本地模型 + 本地生图 | Strata/Qwen 等本地 route | 本机 Qwen Image 2.1 | 主要使用方向，规划和生图都可留在本机；同卡运行时需要显存交接 |

> [!IMPORTANT]
> fish-draws 当前的自动显存交接只适配 [Strata](https://github.com/Niko1221/Strata) 的 `/v1/vram` 接口。其他本地推理框架可以作为 DSH 模型使用，但插件不能保证自动释放和恢复它们的显存；同一张 GPU 上可能出现 OOM 或明显变慢。

## 主要能力

- 文生图、单图编辑和 1～6 图编辑；
- 多图任务使用 `<image1>…<imageN>` 明确每张参考图的职责；
- 用户精确宽高、默认比例表、参考图原始尺寸和非 16 倍数输出；
- Balanced 与 Fast 批量模式；
- 初次执行加最多三次技术重试，质量返工使用独立生成周期；
- 复杂编辑前的视觉事实与扩写提示词确认；
- Strata 专家缓存释放、生成后恢复及异常 journal；
- ComfyUI 自动启动、模型卸载和十分钟空闲关闭；
- 用户自己启动的 ComfyUI 只卸载模型，不关闭进程；
- DSH 对话中同时返回图片和最终扩写提示词；
- 每个任务保留唯一权威输出和可排障的 `result.json`；
- DSH 原生“画图设置”页面、模型档案与固定诊断。

## 前置条件

- Windows 10/11；
- 本地 NVIDIA GPU；
- [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) `>=0.2.1-rc.3 <0.3.0`；
- Node.js `^22.19.0 || >=24.0.0`；
- 可以独立启动并访问网页界面的本地 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)；
- 已准备 Qwen Image 2.1 的 UNet、Qwen3-VL 编码器和 VAE。

当前默认模型文件名：

```text
qwen-image-2.1-UC-Q8_0_2.gguf
qwen3vl_8b_int8_convrot.safetensors
qwen_image_2.1_vae_bf16.safetensors
```

模型文件名可以在“设置 → 画图设置 → 生图模型”中选择和保存。插件不分发模型权重。

### 当前生产工作流需要的节点

| 节点 | 来源 | 说明 |
|---|---|---|
| `UnetLoaderGGUF` | [ComfyUI-GGUF](https://github.com/leejet/ComfyUI-GGUF) | 加载默认 GGUF UNet，需额外安装 |
| `PathchSageAttentionKJ` | [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Sage Attention 链，需额外安装 |
| `QwenImage21Cache` | 新版 ComfyUI 原生 | Balanced/Fast 均使用 |
| `EasyCache` | 新版 ComfyUI 原生 | 仅 Fast 批量模式动态加入 |

Zove-try 的原始 UI 工作流曾建议安装 Rgthree；fish-draws 的生产 API 模板已删除前端开关、组控制和旁路节点，当前不依赖 Rgthree。

<details>
<summary>不知道如何安装两个自定义节点包？把这段提示词交给你的 Agent</summary>

```text
请帮我为 Windows 免安装版 ComfyUI 检查并安装 fish-draws 当前生产工作流需要的自定义节点包：

1. ComfyUI-GGUF
   https://github.com/leejet/ComfyUI-GGUF
2. ComfyUI-KJNodes
   https://github.com/kijai/ComfyUI-KJNodes

我的 ComfyUI 免安装版根目录是：
<请在这里填写实际路径>

执行要求：

1. 先验证根目录中存在 ComfyUI\main.py、ComfyUI\custom_nodes 和 python_embeded\python.exe。
2. 先检查 UnetLoaderGGUF、PathchSageAttentionKJ、QwenImage21Cache、EasyCache 是否已经可用，不要重复安装。
3. UnetLoaderGGUF 应由 ComfyUI-GGUF 提供；PathchSageAttentionKJ 应由 ComfyUI-KJNodes 提供；QwenImage21Cache 和 EasyCache 应由当前 ComfyUI 原生提供。fish-draws 当前不依赖 Rgthree，不要为本任务安装它。
4. 如果目标目录已存在，检查 Git remote 和未提交修改。不要覆盖有本地修改或来源不一致的目录，先向我报告。
5. 缺失时把两个仓库分别克隆到 ComfyUI\custom_nodes。
6. 如有 requirements.txt，只使用便携版自己的 python_embeded\python.exe -s -m pip 安装，禁止调用系统 Python。
7. 不要安装其他插件、模型或工作流，不要修改用户工作流、模型、输入、输出和全局配置。
8. 如果 ComfyUI 正在运行，不要自行强制关闭；需要重启时先通知我。
9. 重启后通过 /object_info 或等效只读接口验证上述四个节点。
10. 报告实际安装目录、仓库 origin/commit、依赖结果、节点可用性和剩余问题。

路径不明确、目录有本地修改、需要额外权限或需要下载其他组件时，立即停止并询问我。
```

</details>

## 安装

把 `<profile-name>` 换成 DSH 实际使用的 profile：

```powershell
dsh plugin --profile <profile-name> add @izzyj4ck/dsh-fish-draws
```

重启 DSH 后，应在“设置”中看到“画图设置”，并在 skill catalog 中看到 `fish-draws`。

## 公共设置

两种使用方式都需要先完成这些步骤：

1. 打开“设置 → 画图设置 → ComfyUI”；
2. 将“ComfyUI 根目录”指向包含 `main.py` 的目录；
3. 保持 API 为 loopback，例如 `http://127.0.0.1:8188`；
4. 点击“检查连接”；ComfyUI 离线时可以点击“测试启动”；
5. 进入“生图模型”，点击“发现模型候选”；
6. 选择 UNet、CLIP 和 VAE，保存为模型档案；
7. 点击“检查档案”。

设置在 preflight 时生成不可变快照。任务运行期间修改设置，只会影响下一次任务，不会改变已经提交的工作流或 Strata 恢复目标。

## 快速入门一：DeepSeek 官方模型 + 本地生图

示例使用 `DeepSeek-V4.1-Flash 1017 High` 负责需求理解和提示词扩写，Qwen Image 2.1 仍在本机生成图片。

1. 在 DSH 的模型设置中配置 DeepSeek 官方 API；
2. 新建会话并选择 `DeepSeek-V4.1-Flash 1017 High`；
3. 完成上面的 ComfyUI 和生图模型公共设置；
4. 如果本机没有同时运行 Strata，在“DSH 与 Strata”中关闭显存交接；
5. 在会话中发送：

```text
使用fish-draws，画一只在雨夜东京小巷里戴红围巾的橘猫，16:9
```

DSH 模型会扩写提示词，fish-draws 将 `16:9` 解析为默认 `1920×1080`，然后调用本地 ComfyUI。任务结束后，对话中会显示图片与扩写提示词。

<p align="center">
  <img src="./docs/images/result-deepseek-v4.1-flash.webp" alt="DeepSeek-V4.1-Flash 1017 High 规划、本地 Qwen Image 2.1 生成的雨夜橘猫" width="900">
</p>
<p align="center"><sub>DeepSeek-V4.1-Flash 1017 High 负责规划；本地 Qwen Image 2.1 负责生成。</sub></p>

> [!NOTE]
> 此快速入门验证的是文生图链路。参考图编辑还要求当前 DSH 模型能够可靠读取图片附件。

## 快速入门二：Strata/Qwen + 本地生图

这是 fish-draws 的主要使用方向。本项目测试示例使用 [Strata](https://github.com/Niko1221/Strata) 承载 `Qwen3.8 Flash-Next IQ3_S`，DSH reasoning effort 为 `High`。

1. 按 Strata 仓库说明安装 Strata、模型并启动本地服务；
2. 在 DSH 中把 Strata 的 OpenAI-compatible 推理服务注册为模型 route；
3. 新建会话并选择该本地 Qwen route；
4. 进入“设置 → 画图设置 → DSH 与 Strata”；
5. 开启 Strata 显存交接；
6. 填写 Strata VRAM endpoint，例如 `http://127.0.0.1:8080`；
7. 根据 Strata 配置选择 `none` 或 `bearer`。Bearer 密钥只能通过 DSH credentials 单向写入，不会回显；
8. 在“诊断”页刷新模型目录，选择该 route，并明确确认它只访问本机；
9. 保存后运行一次固定文生图诊断；
10. 在普通会话发送同样的提示词：

```text
使用fish-draws，画一只在雨夜东京小巷里戴红围巾的橘猫，16:9
```

执行顺序：

```text
本地 Qwen 完成理解与提示词扩写
→ Strata 暂时释放专家缓存
→ Qwen Image 2.1 进入显存并生成图片
→ ComfyUI 卸载全部模型
→ Strata 恢复任务开始前的 reserve
```

<p align="center">
  <img src="./docs/images/result-strata-qwen.webp" alt="Strata Qwen 规划、本地 Qwen Image 2.1 生成的雨夜橘猫" width="900">
</p>
<p align="center"><sub>Strata/Qwen3.8 Flash-Next IQ3_S High 负责规划；本地 Qwen Image 2.1 负责生成。</sub></p>

上面两张图片使用同一条初始要求，用于展示两条可用路径，不构成语言模型或生图质量基准。

## 更多用法

### 文生图

```text
使用fish-draws，画一座漂浮在云海上的东方未来城市，3:2
```

### 单图编辑

上传一张图片：

```text
使用fish-draws，把外套改成深蓝色，其他内容保持不变，输出尺寸沿用原图。
```

### 多图编辑

按顺序上传两张图片：

```text
使用fish-draws，把图一中的茶壶完整放到图二的教室桌面上，最终画布使用图二原始尺寸。
```

复杂任务会先展示逐图视觉事实、`<image1>/<image2>` 职责和扩写提示词，确认后才生成。

### 批量抽卡

```text
使用fish-draws，按同一个要求生成4张让我挑选，16:9。
```

明确要求多张、抽卡或比较时，整批图片都是正式输出，不会因为候选保留设置关闭而删除。

## 输出与留存

默认权威输出目录：

```text
<OutputRoot>\fish-draws\<YYYY-MM-DD>\<TaskId>\
├─ image-1.png
└─ result.json
```

- 单图任务默认只长期保留最终图片和 `result.json`；
- 多图/抽卡任务保留整批正式输出；
- `retainAllSuccessfulCandidates=true` 时额外保留通过完整验证的候选；
- 技术失败半成品、损坏文件和错误尺寸图片始终清理；
- `result.json` 记录工作流版本、提示词、reference 哈希、尺寸、seed、技术尝试、生命周期和清理状态，但不保存 API key、会话全文或参考图绝对路径。

## ComfyUI 生命周期

| ComfyUI 来源 | 任务结束时 | 空闲十分钟后 |
|---|---|---|
| 用户手动启动 | 卸载模型并恢复 Strata，不关闭进程 | 不关闭 |
| fish-draws 自动启动 | 卸载模型并恢复 Strata | 无新任务时自动关闭 |

设置页的“停止插件启动的 ComfyUI”只作用于当前 DSH Host 仍持有活 `ChildProcess` 句柄的实例。插件不会扫描或终止任意 Python 进程。

## 安全与隐私

- 使用云端 DSH 模型时，原始要求、扩写上下文以及该模型需要观察的附件可能会发送给对应模型提供商；“本地生图”只表示 ComfyUI/Qwen Image 生成阶段在本机执行；
- ComfyUI 和 Strata 只允许 loopback URL；
- 不接受工具参数传入任意命令、脚本、工作流 JSON 或节点图；
- workflow 拓扑与 SHA-256 绑定在发布包内；
- credential 由 DSH credentials 逐次解析，不写入配置、日志和任务 manifest；
- 不删除用户原始参考图、其他任务文件、ComfyUI 全局配置或数据库；
- 不关闭用户自己启动的 ComfyUI；
- 正式输出必须能够追溯到 Qwen Image 核心生成步骤；
- Host 不嵌套调用 Strata completions，扩写始终由当前 DSH 会话模型完成。

## 已知限制

- 公开版本只支持 Windows 10/11、本地 NVIDIA GPU 和本地 ComfyUI；
- 不自动安装 ComfyUI、模型、自定义节点或任意第三方工作流；
- 当前生产工作流固定面向 Qwen Image 2.1；
- 自动显存交接仅适配 Strata；
- 高分辨率图像编辑可能显著增加显存压力与生成时间；
- 2560×1440 和 1440×2560 是否流畅取决于任务类型、模型量化和可释放显存；
- 用户启动或 DSH 重启后只剩 PID 记录的 ComfyUI，必须由用户从原控制台关闭。

## 常见问题

### 设置页没有出现

确认插件安装在 DSH 实际启动的 profile 中，重启 DSH，并检查插件没有处于禁用或恢复模式。

### ComfyUI 连接失败

确认根目录确实包含 `main.py`，API URL 为 loopback，且端口没有被其他程序占用。使用设置页“检查连接”和“运行只读诊断”获取脱敏报告。

### 找不到模型或节点

先在 ComfyUI 中确认模型文件和节点可用，再使用“发现模型候选”。不要通过 Agent 随意搜索并安装未知节点。

### 高分辨率任务很慢

这通常表示可用显存接近上限并发生内存迁移。降低尺寸、释放更多 Strata 专家缓存或使用更轻的模型档案；fish-draws 不会静默缩小用户要求的尺寸。

### ComfyUI 已完成，但 DSH 没有返回图片

运行 `fish_draws_result` 或设置页只读诊断，检查 `result.json` 中的 failure、lifecycle 和 cleanup。输出晋升会对 Windows 临时文件锁重试，并在必要时使用哈希校验复制回退。

## 升级与卸载

升级：

```powershell
dsh plugin --profile <profile-name> add @izzyj4ck/dsh-fish-draws@latest
```

禁用或卸载插件不会删除正式图片、`result.json`、诊断结果或等待选择的候选。3.0 升级到 3.1+ 时，旧模型与 safety 配置会迁移为“原有配置”档案，并保留回滚兼容镜像。

## 开发与验证

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run release:check
```

`release:check` 执行类型检查、Host/Client 测试、构建、授权、路径、发布文件和敏感信息检查。

## 授权与致谢

插件原创代码使用 [MIT License](./LICENSE)。

内置工作流和提示词参考由 **Zove-try** 分享的材料演化而来；作者已书面允许修改、通过 GitHub/npm 公开再分发及商业使用，并要求署名：

- [Zove-try 原始 RunningHub 工作流](https://www.runninghub.ai/zh-cn/post/2103708646000660481/?inviteCode=rh-v1315)
- [演示视频](https://www.bilibili.com/video/BV1HVhX6AEC6/)
- [第三方声明](./THIRD_PARTY_NOTICES.md)
- [授权记录摘要](./assets/licensing/AUTHORIZATION.md)

模型、ComfyUI、自定义节点和其他第三方软件各自遵循其原许可证，不包含在本项目的 MIT 再许可范围内。
