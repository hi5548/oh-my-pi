import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	description: "通过标准输入输出运行 ACP（Agent Client Protocol）服务器",
} satisfies CommandMetadata;

export const agentsHelp = { description: "管理内置任务代理" } satisfies CommandMetadata;

export const authBrokerHelp = {
	description: "管理 omp auth-broker（凭据保险库）",
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: "运行由已配置凭据代理支持的 auth-gateway 转发代理",
} satisfies CommandMetadata;

export const benchHelp = {
	description:
		"基准测试模型：比较 TTFT/预填充与解码吞吐量（含 p50/p95），覆盖聊天、预填充、生成和提示缓存负载",
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: "运行本地 CDP 中继，让浏览器工具控制你自己的 Chrome 标签页",
} satisfies CommandMetadata;

export const cleanseHelp = {
	description: "使用加权并行子代理检测并修复项目诊断问题",
} satisfies CommandMetadata;

export const collabHelp = {
	description:
		"列出本机正在运行的协作主机元数据（不含 URL）；用 collab link <instanceId|pid> 获取控制链接（--view 为只读）",
} satisfies CommandMetadata;

export const collabHelp = {
	description:
		"列出本机正在运行的协作主机元数据（不含 URL）；用 collab link <instanceId|pid> 获取控制链接（--view 为只读）",
} satisfies CommandMetadata;

export const commitHelp = { description: "生成提交说明并更新变更日志" } satisfies CommandMetadata;

export const completionsHelp = {
	description: "输出 shell 补全脚本（bash、zsh 或 fish）",
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: "将文本文件改写为紧凑提示词登记表，并报告丢弃的内容",
} satisfies CommandMetadata;

export const configHelp = { description: "管理配置设置" } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: "试运行 OAuth 账户在随机会话 ID 之间的均衡",
} satisfies CommandMetadata;

export const galleryHelp = {
	description: "在确定性的可视化画廊中预览工具、输入框和状态栏渲染器",
} satisfies CommandMetadata;

export const gcHelp = { description: "运行存储垃圾回收" } satisfies CommandMetadata;
export const ifBenchHelp = {
	description:
		"基准测试指令遵循和工作记忆：使用一条缓存的字形数组操作线程和不断变化的猫叫指令",
} satisfies CommandMetadata;
export const gitHelp = {
	description: "交互式全屏 Git 界面：分栏差异查看器、暂存侧栏和提交编辑器",
} satisfies CommandMetadata;

export const grepHelp = { description: "测试 grep 工具" } satisfies CommandMetadata;

export const grievancesHelp = {
	description: "查看、清理或推送已报告的工具问题（自动 QA 问题）",
} satisfies CommandMetadata;

export const imagesHelp = {
	description: "检查、诊断、探测和清理图像发布后端",
} satisfies CommandMetadata;

export const installHelp = {
	description: "安装或链接扩展包（等同于 `plugin install`/`plugin link`）",
} satisfies CommandMetadata;

export const joinHelp = { description: "加入共享协作会话（同 /join）" } satisfies CommandMetadata;

export const modelsHelp = { description: "列出、搜索并刷新可用模型" } satisfies CommandMetadata;

export const pluginHelp = { description: "管理扩展（安装、卸载、列出等）" } satisfies CommandMetadata;

export const psHelp = {
	description: "列出并控制由守护进程管理的后台进程（日志、停止、终止、重启）",
} satisfies CommandMetadata;

export const readHelp = {
	description: "显示 read 工具将为路径、URL 或内部 URI 返回的内容",
} satisfies CommandMetadata;
export const renderHelp = {
	description: "通过正式的会话记录流水线绘制整个会话线程（包括重绘耗时）",
} satisfies CommandMetadata;

export const sayHelp = {
	description: "使用本地 TTS 引擎合成文本，并通过扬声器播放",
} satisfies CommandMetadata;

export const searchHelp = { description: "测试网页搜索服务商" } satisfies CommandMetadata;

export const shareHelp = {
	description: "通过加密链接分享已保存的会话（同 /share）",
} satisfies CommandMetadata;

export const setupHelp = {
	description: "运行首次设置，或为可选功能安装依赖",
} satisfies CommandMetadata;

export const shellHelp = { description: "交互式 Shell 控制台" } satisfies CommandMetadata;

export const sshHelp = { description: "管理 SSH 主机配置" } satisfies CommandMetadata;

export const statsHelp = { description: "查看使用统计" } satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: "下载本地轻量模型（会话标题和记忆）",
} satisfies CommandMetadata;

export const tokenHelp = { description: "获取服务商的 API key 或 OAuth token" } satisfies CommandMetadata;

export const ttsrHelp = {
	description: "检查和测试时间旅行流规则（TTSR）",
} satisfies CommandMetadata;

export const updateHelp = { description: "检查并安装更新" } satisfies CommandMetadata;

export const usageHelp = {
	description: "显示每个已认证账户的服务商用量限制",
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: "添加、列出或清理 Git worktree（启用时优先克隆）",
} satisfies CommandMetadata;
