import * as path from "node:path";
import {
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
	type ResolveCliModelResult,
} from "../config/model-resolver";
import type { SettingPath, Settings } from "../config/settings";
import { describeLoopCondition } from "../modes/loop-condition";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/**
 * Resolve a `/model` / `/switch` selector the way `omp bench` and `--model`
 * do: exact `provider/id`, fuzzy ids (`opus`), role aliases (`@smol`, `smol`),
 * and `:level` thinking suffixes. Unqualified selectors prefer the session's
 * `--models` scope, else the authenticated set, before the full catalog.
 */
function resolveSessionModelSelector(
	selector: string,
	session: AgentSession,
	settings: Settings,
): ResolveCliModelResult {
	const scoped = session.scopedModels.map(entry => entry.model);
	return resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		if (!submitted && ((runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0)) {
			editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
			editor.pendingImageLinks = [
				...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
				...editor.pendingImageLinks,
			];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
	} catch (error) {
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return settings.get("extendedContext") ? "on" : "off";
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = settings.get("extendedContext");
	if (!arg || arg === "toggle") {
		const enabled = !current;
		settings.set("extendedContext", enabled);
		return `Extended context ${enabled ? "enabled" : "disabled"}.`;
	}
	if (arg === "on") {
		settings.set("extendedContext", true);
		return "加长上下文已开启。";
	}
	if (arg === "off") {
		settings.set("extendedContext", false);
		return "加长上下文已关闭。";
	}
	if (arg === "status") return `Extended context is ${formatExtendedContextStatus(settings)}.`;
	return undefined;
}

/** Detailed, session-effective `/computer status` diagnostics. */
function formatComputerUseStatus(session: AgentSession): string {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEvalPreludes().some(definition => definition.name === "computer");
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	return [
		`桌面操控：${enabled ? "已启用" : "已禁用"}`,
		`预置：${active ? "已激活" : "未激活"}`,
		`已配置：display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle and rebuild the current prompt.
 * The override is never persisted to settings.json.
 */
async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const previous = session.settings.get("computer.enabled");
	session.settings.override("computer.enabled", enable);
	if (enable && !session.getEvalPreludes().some(definition => definition.name === "computer")) {
		session.settings.override("computer.enabled", previous);
		return "本会话不支持桌面操控。";
	}
	try {
		await session.refreshBaseSystemPrompt();
	} catch (error) {
		session.settings.override("computer.enabled", previous);
		throw error;
	}
	return enable
		? `本会话已启用桌面操控。${formatComputerUseStatus(session)}`
		: "本会话已禁用桌面操控。";
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		icon: "shield",
		description: "计划、运行、查看、导入和对比安全扫描",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "创建安全扫描计划" },
			{ name: "scan", description: "启动一次安全扫描" },
			{ name: "status", description: "查看扫描状态" },
			{ name: "cancel", description: "取消正在运行的扫描" },
			{ name: "scans", description: "列出已保存的扫描记录" },
			{ name: "show", description: "查看扫描结果详情" },
			{ name: "import", description: "导入 SARIF 或 Codex 安全报告" },
			{ name: "export", description: "导出扫描报告" },
			{ name: "validate", description: "用内置工具验证一个发现" },
			{ name: "compare", description: "对比两次扫描的差异" },
			{ name: "disposition", description: "标记发现项的处理结论" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		icon: "settings",
		description: "打开设置菜单",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		icon: "gear",
		description: "打开服务商设置",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "配置登录和网页搜索服务商" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`用法：/${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		icon: "plan",
		description: "切换计划模式（先规划再执行）",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled" as SettingPath)) return "计划：已在设置中停用";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `计划：开${planFile ? `（${path.basename(planFile)}）` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "计划：被目标模式占用";
			return "计划：关";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "plan-review",
		icon: "plan",
		description: "重新打开最近一次计划的审核（仅计划模式）",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? "计划审核：可用" : "计划审核：未开启计划模式",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vibe",
		icon: "wave",
		description: "切换轻松模式（持久的快速 worker 会话，仅只读工具）",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "轻松：开";
			if (runtime.ctx.planModeEnabled) return "轻松：被计划模式占用";
			if (runtime.ctx.goalModeEnabled) return "轻松：被目标模式占用";
			return "轻松：关";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		icon: "goal",
		description: "切换目标模式（本会话的持久自主目标）",
		subcommands: [
			{ name: "set", description: "设置或替换目标", usage: "<objective>" },
			{ name: "show", description: "查看当前目标详情" },
			{ name: "pause", description: "暂停当前目标" },
			{ name: "resume", description: "恢复已暂停的目标" },
			{ name: "drop", description: "放弃当前目标" },
			{ name: "budget", description: "调整 token 预算", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return "目标：已在设置中停用";
			if (runtime.ctx.planModeEnabled) return "目标：被计划模式占用";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `目标：${state.goal.status}（${shortDetail(state.goal.objective)}）` : "目标：关";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		icon: "compass",
		description: "让代理在对话中采访你，然后设置目标模式",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		icon: "loop",
		description:
			"切换循环模式。开启后，你发送的提示会在代理每次让出时自动重新提交。可用次数或时长限定，或用 `--until '<cmd>'` / `--while '<cmd>'` 设条件——命令的退出状态决定下一轮是否继续。Esc 取消当前一轮；再次输入 /loop 关闭。",
		inlineHint: "[count|duration] [--while|--until '<cmd>'] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "循环：关";
			if (runtime.ctx.loopModePaused) return "循环：已暂停";
			const bounds = [
				runtime.ctx.loopLimit ? describeLoopLimitRuntime(runtime.ctx.loopLimit) : undefined,
				runtime.ctx.loopCondition ? describeLoopCondition(runtime.ctx.loopCondition) : undefined,
			].filter((part): part is string => part !== undefined);
			if (bounds.length > 0) return `循环：开（${bounds.join("、")}）`;
			if (runtime.ctx.loopPrompt) return "循环：开（重复提示）";
			return "循环：开（等待下一个提示）";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		icon: "inbox",
		description: "把消息排队，等代理让出后再发送",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		icon: "model",
		description: "切换本会话使用的模型",
		acpDescription: "查看当前模型",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `模型：${model.provider}/${model.id}` : "模型：未选择";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const selector = command.args.trim();
				const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
				const match = resolved.model;
				if (!match) {
					return usage(
						`Unknown model: ${selector}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					if (resolved.thinkingLevel !== undefined) runtime.session.setThinkingLevel(resolved.thinkingLevel);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		icon: "swap",
		description: "切换本会话使用的模型（同 Alt+P）；支持模糊 ID、provider/id、@role、:level",
		acpDescription: "仅切换本会话使用的模型",
		acpInputHint: "[model]",
		inlineHint: "[model]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `模型：${model.provider}/${model.id}` : "模型：未选择";
		},
		handle: async (command, runtime) => {
			const selector = command.args.trim();
			if (!selector) {
				const model = runtime.session.model;
				await runtime.output(
					model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
				);
				return commandConsumed();
			}
			const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			if (!resolved.model) return usage(`Unknown model: ${selector}`, runtime);
			try {
				await runtime.session.setModelTemporary(resolved.model, resolved.thinkingLevel);
				await runtime.output(`Session-only model: ${formatModelString(resolved.model)}.`);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to switch model: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const selector = command.args.trim();
			if (!selector) {
				runtime.ctx.showModelSelector({ temporaryOnly: true });
				return;
			}
			const resolved = resolveSessionModelSelector(selector, runtime.ctx.session, runtime.ctx.settings);
			if (!resolved.model) {
				runtime.ctx.showError(`Unknown model: ${selector}`);
				return;
			}
			if (resolved.warning) runtime.ctx.showStatus(resolved.warning);
			await runtime.ctx.switchSessionModel(resolved.model, resolved.thinkingLevel);
		},
	},
	{
		name: "fast",
		icon: "fast",
		description: "切换高速服务档位（更快的响应通道）",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "开启高速模式" },
			{ name: "off", description: "关闭高速模式" },
			{ name: "status", description: "查看高速模式状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `高速：${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("用法：/fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.",
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`Fast mode is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法：/fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "skillful",
		icon: "compass",
		description: "Toggle listing available skills in the system prompt (session only)",
		acpDescription: "Toggle skill listing",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "List skills in the prompt for this session" },
			{ name: "off", description: "Omit the skills listing for this session" },
			{ name: "status", description: "Show skill listing status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Skill listing: ${runtime.ctx.session.settings.get("skillful") ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(
					`Skill listing: ${runtime.session.settings.get("skillful") ? "on" : "off"} (session override; default from the skillful setting).`,
				);
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.session.setSkillful(true)
						: arg === "off"
							? await runtime.session.setSkillful(false)
							: await runtime.session.toggleSkillful();
				await runtime.output(`Skill listing ${enabled ? "enabled" : "disabled"} for this session.`);
				return commandConsumed();
			}
			return usage("Usage: /skillful [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(`Skill listing: ${runtime.ctx.session.settings.get("skillful") ? "on" : "off"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.ctx.session.setSkillful(true)
						: arg === "off"
							? await runtime.ctx.session.setSkillful(false)
							: await runtime.ctx.session.toggleSkillful();
				runtime.ctx.showStatus(`Skill listing ${enabled ? "enabled" : "disabled"} for this session.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /skillful [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extended-context",
		icon: "expand",
		description: "切换加长上下文窗口",
		acpDescription: "切换加长上下文",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "开启更大的上下文窗口" },
			{ name: "off", description: "使用默认或标准价位的上下文窗口" },
			{ name: "status", description: "查看加长上下文状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Extended context: ${formatExtendedContextStatus(runtime.ctx.settings)}`,
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage("用法：/extended-context [on|off|status]", runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? "用法：/extended-context [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "computer",
		icon: "computer",
		description: "切换本会话的原生桌面操控预置",
		acpDescription: "Toggle computer use",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "开启本会话的桌面操控" },
			{ name: "off", description: "关闭本会话的桌面操控" },
			{ name: "status", description: "查看桌面操控状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`桌面操控：${runtime.ctx.session.settings.get("computer.enabled") ? "开" : "关"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("用法：/computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatComputerUseStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !runtime.ctx.session.settings.get("computer.enabled");
				runtime.ctx.showStatus(await applyComputerUseToggle(runtime.ctx.session, enable));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法：/computer [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "prewalk",
		icon: "prewalk",
		description: "准备或重启一次性的模型交接",
		allowArgs: true,
		acpDescription: "准备或重启 prewalk 交接",
		acpInputHint: "[restart]",
		subcommands: [{ name: "restart", description: "回到 @default 并重新准备向 @smol 的交接" }],
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg && arg !== "restart") return usage("用法：/prewalk [restart]", runtime);
			const target = resolveSessionModelSelector("@smol", runtime.session, runtime.settings);
			if (target.error || !target.model) {
				return usage(target.error ?? '未找到模型 "@smol"', runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(target.model)) {
				return usage(`No API key for ${target.model.provider}/${target.model.id}`, runtime);
			}
			if (arg === "restart") {
				const source = resolveSessionModelSelector("@default", runtime.session, runtime.settings);
				if (source.error || !source.model) {
					return usage(source.error ?? 'Model "@default" not found', runtime);
				}
				if (!runtime.session.modelRegistry.hasConfiguredAuth(source.model)) {
					return usage(`No API key for ${source.model.provider}/${source.model.id}`, runtime);
				}
				const result = await runtime.session.restartPrewalk(
					source.model,
					source.thinkingLevel,
					target.model,
					target.thinkingLevel,
				);
				if (result === "rejected") return commandConsumed();
				const restartSource = `${source.model.provider}/${source.model.id}`;
				await runtime.output(
					result === "armed"
						? `Prewalk restarted: using @default (${restartSource}) for planning, then switching to @smol (${target.model.provider}/${target.model.id}) at the next edit/write (todo-gated).`
						: `Prewalk reset: using @default (${restartSource}); @smol resolves to the same model and thinking level, so no handoff was armed.`,
				);
				return commandConsumed();
			}
			const armed = runtime.session.armPrewalk(target.model, target.thinkingLevel);
			if (armed) {
				await runtime.output(
					`Prewalk on: switching to ${target.model.provider}/${target.model.id} at the next edit/write (todo-gated).`,
				);
			}
			return commandConsumed();
		},
	},
];
