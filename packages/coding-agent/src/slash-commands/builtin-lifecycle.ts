import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import type { AgentSession, FreshSessionResult, HandoffResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { buildReplanTitleContext, USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveResumableSession } from "../session/session-listing";
import { toggleSessionPin } from "../session/session-pins";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
	type SessionWorktree,
} from "../session/session-worktree";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { isLowSignalTitleInput } from "../tiny/text";
import { resolveToCwd } from "../tools/path-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}

/** Null reports no usable title; undefined silently discards an invalidated request. */
async function generateRenameTitle(session: AgentSession, signal?: AbortSignal): Promise<string | null | undefined> {
	const { sessionManager } = session;
	const context = buildReplanTitleContext(session.messages);
	if (!context || isLowSignalTitleInput(context)) return null;
	const revision = sessionManager.reserveTitleRevision();
	const sessionId = sessionManager.getSessionId();
	const titleSignal = session.titleGenerationSignal;
	const cleanupProgress = session.notifyTitleGenerationStart();
	try {
		const title = await session.generateTitle(context, undefined, signal);
		return !titleSignal.aborted &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.titleRevision === revision
			? title
			: undefined;
	} finally {
		cleanupProgress?.();
	}
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	if (verb === "thinking") return "thinking";
	return { error: `Unknown /shake mode "${verb}". Use elide, images, or thinking.` };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = ["Workspace directories:", `  ${cwd} (working directory)`, ...additional.map(d => `  ${d}`)];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}
async function fatalMoveFailure(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	await runtime.session.dispose();
	return commandConsumed();
}

/**
 * Relocate the headless session to `resolvedPath` (an existing directory):
 * flush settings, move the session file, re-scope the process, rolling back
 * on failure. Returns a result when the move did not complete; `undefined`
 * on success so the caller can report its own confirmation.
 */
async function relocateHeadlessSession(
	runtime: SlashCommandRuntime,
	resolvedPath: string,
): Promise<SlashCommandResult | undefined> {
	try {
		await runtime.settings.flush();
	} catch (err) {
		return usage(`Failed to save pending settings: ${errorMessage(err)}`, runtime);
	}
	const previousState = runtime.sessionManager.captureState();
	try {
		await runtime.session.moveSession(resolvedPath);
	} catch (err) {
		return usage(`Move failed: ${errorMessage(err)}`, runtime);
	}
	try {
		setProjectDir(resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			const actual = runtime.sessionManager.getCwd();
			let realigned = false;
			try {
				await rescopeHeadlessToCwd(runtime, actual);
				realigned = true;
			} catch {}
			if (!realigned) {
				return fatalMoveFailure(
					`Move failed and rollback failed: ${errorMessage(rollbackError)} (failed to re-align workspace to ${actual}; process remains at source while session is at ${actual})`,
					runtime,
				);
			}
			return usage(
				`Move failed and rollback failed: ${errorMessage(rollbackError)} (workspace remains at ${actual})`,
				runtime,
			);
		}
		return usage(`Move failed: ${errorMessage(err)}`, runtime);
	}
	try {
		await rescopeHeadlessToCwd(runtime, resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
			await rescopeHeadlessToCwd(runtime, previousState.cwd);
		} catch (rollbackError) {
			const actual = runtime.sessionManager.getCwd();
			let realigned = false;
			try {
				await rescopeHeadlessToCwd(runtime, actual);
				realigned = true;
			} catch {}
			if (!realigned) {
				return fatalMoveFailure(
					`Move failed and rollback failed: ${errorMessage(rollbackError)} (failed to re-align workspace to ${actual}; process remains at source while session is at ${actual})`,
					runtime,
				);
			}
			return usage(
				`Move failed and rollback failed: ${errorMessage(rollbackError)} (workspace remains at ${actual})`,
				runtime,
			);
		}
		return usage(`Move failed: ${errorMessage(err)}`, runtime);
	}
	await runtime.notifyConfigChanged?.();
	await runtime.notifyTitleChanged?.();
	return undefined;
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ssh",
		icon: "host",
		description: "管理 SSH 主机（添加、列出、删除）",
		acpDescription: "管理 SSH 连接",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "添加一台 SSH 主机",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
			},
			{ name: "list", description: "列出所有已配置的 SSH 主机" },
			{ name: "remove", description: "删除一台 SSH 主机", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "查看帮助" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		icon: "plus",
		description: "开始一个新会话",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "fresh",
		icon: "restart",
		description: "重置服务商连接状态（不改本地对话记录）",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? "重置：正在输出中，暂不可用" : "重置：可用",
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					"Wait for the current response to finish or abort it before refreshing provider state.",
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "clear",
		icon: "eraser",
		description: "清空对话上下文，但保留会话",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? "清空：正在输出中，暂不可用" : "清空：丢弃上下文，保留会话",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "delete",
		icon: "trash",
		description: "删除当前会话并新建一个",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDeleteCommand();
		},
	},
	{
		name: "compact",
		icon: "compress",
		description: "手动压缩会话上下文",
		acpDescription: "压缩对话",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage ? `压缩：上下文已用 ${Math.round(usage.percent)}%` : "压缩：上下文不可用";
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const runCompact = async (): Promise<void> => {
				const before = runtime.session.getContextUsage?.();
				const beforeTokens = before?.tokens;
				try {
					await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
				} catch (err) {
					// RPC `abort` and ACP `session/cancel` propagate their explicit
					// USER_INTERRUPT_LABEL through the compaction abort signal. The client
					// already saw the interrupt it sent; emitting anything here would
					// append an out-of-turn chunk. Other cancellations (including an
					// extension veto) remain visible.
					if (err instanceof CompactionCancelledError && err.cause === USER_INTERRUPT_LABEL) return;
					// Compaction precondition failures (no model, already compacted, too
					// small) and provider errors propagate as plain Errors; surface them
					// via runtime.output so they don't fail the ACP prompt turn.
					await runtime.output(`Compaction failed: ${errorMessage(err)}`);
					return;
				}
				const after = runtime.session.getContextUsage?.();
				const afterTokens = after?.tokens;
				if (beforeTokens != null && afterTokens != null) {
					const saved = beforeTokens - afterTokens;
					await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
				} else {
					await runtime.output("Compaction complete.");
				}
			};
			// Provider-backed: background-dispatch under RPC so the serialized command
			// queue stays free for `abort` (SlashCommandRuntime.runCommandInBackground).
			// ACP/TUI have no such hook and keep the inline await.
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runCompact);
				return commandConsumed();
			}
			await runCompact();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "shake",
		icon: "vibrate",
		description: "从上下文中丢弃大块内容（工具结果等）",
		acpDescription: "清理上下文中的大块内容",
		subcommands: [
			{ name: "elide", description: "去掉工具结果和大块内容（默认）" },
			{ name: "images", description: "去掉图片内容" },
			{ name: "thinking", description: "去掉全部思考过程" },
		],
		acpInputHint: "[elide|images|thinking]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		icon: "handoff",
		description: "把当前会话交给一个新会话继续",
		acpDescription: "生成交接文档并原地压缩",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage("Wait for the current response to finish or abort it before handing off.", runtime);
			}
			if (runtime.session.isGeneratingHandoff) {
				return usage("Handoff generation is already in progress.", runtime);
			}
			const runHandoff = async (): Promise<void> => {
				let result: HandoffResult | undefined;
				try {
					result = await runtime.session.handoff(command.args || undefined);
				} catch (err) {
					const message = errorMessage(err);
					// A user interrupt (ACP `session/cancel`, TUI Esc) already settled the
					// owning turn: `AgentSession.abort()` forwards its reason into the
					// handoff abort controller, and `throwIfHandoffAborted` rethrows a
					// reasoned abort verbatim — so the throw arrives as
					// `USER_INTERRUPT_LABEL`, not "Handoff cancelled". Emitting anything
					// here would append an out-of-turn chunk after the client already saw
					// `stopReason: "cancelled"`, so consume silently.
					if (message === USER_INTERRUPT_LABEL) {
						return;
					}
					// `session.handoff()` normalizes an unreasoned cancellation to this
					// exact message; every other throw is a real failure (no model
					// selected, nothing to hand off, already compacted, provider error)
					// and is surfaced verbatim behind the same "<verb> failed:" prefix
					// `/compact` uses.
					if (message === "Handoff cancelled") {
						await runtime.output("Handoff cancelled.");
						return;
					}
					// Persist the real failure so it stays debuggable after the client
					// message scrolls away (same rationale as the TUI path, #7993).
					logger.error("Handoff failed", { error: message });
					await runtime.output(`Handoff failed: ${message}`);
					return;
				}
				if (!result) {
					await runtime.output("Handoff cancelled.");
					return;
				}
				// `savedPath` is deliberately not reported: `SessionHandoff` only writes
				// the document to disk when `options.autoTriggered` is set, which the
				// user-invoked path never passes.
				await runtime.output("Context handed off and compacted in place.");
			};
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runHandoff);
				return commandConsumed();
			}
			await runHandoff();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		icon: "history",
		description: "恢复另一个会话",
		inlineHint: "[session id|@claude|@codex]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			runtime.ctx.editor.setText("");
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(`Session "${sessionArg}" not found`);
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	{
		name: "pin",
		icon: "pin",
		description: "把会话固定/取消固定在恢复列表顶部",
		inlineHint: "[session id]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const sessionArg = command.args.trim();
			let sessionId: string | undefined;
			if (sessionArg) {
				const match = await resolveResumableSession(
					sessionArg,
					runtime.cwd,
					runtime.sessionManager.getSessionDir(),
					{ allowGlobalFallback: true },
				);
				if (!match) {
					return usage(`Session "${sessionArg}" not found.`, runtime);
				}
				sessionId = match.session.id;
			} else {
				sessionId = runtime.sessionManager.getSessionId();
				if (!sessionId) {
					return usage("No active session to pin.", runtime);
				}
			}
			const pinned = await toggleSessionPin(sessionId);
			await runtime.output(pinned ? "Session pinned to the top of the resume list." : "Session unpinned.");
			return commandConsumed();
		},
	},
	{
		name: "btw",
		icon: "question",
		description: "追问一个侧边问题，或浏览本会话的追问历史",
		inlineHint: "[question]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "tan",
		icon: "rocket",
		description: "让一个后台代理去处理旁支工作",
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work);
		},
	},
	{
		name: "omfg",
		icon: "rule",
		description: "把你的抱怨变成一条规则，阻止重复行为",
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "cleanse",
		icon: "stethoscope",
		description: "用并行子代理检测并修复项目诊断问题",
		inlineHint: "[request] [--all]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleCleanseCommand(args);
		},
	},
	{
		name: "retry",
		icon: "redo",
		description: "重试上一次失败的回合",
		handle: async (_command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage("Wait for the current response to finish or abort it before retrying.", runtime);
			}
			const didRetry = await runtime.session.retry();
			if (!didRetry) {
				return usage("Nothing to retry.", runtime);
			}
			await runtime.output("Retrying the last failed turn.");
			// `AgentSession.retry()` only schedules the continuation as a
			// post-prompt task; it returns before the retried turn streams. Hosts
			// whose prompt turn owns the event subscription (ACP) must stay open
			// across that turn — `AcpAgent.prompt` installs the subscription
			// before running the command and `#finishPrompt` unsubscribes, so
			// returning early would silently swallow the entire retried turn
			// (model output and tool calls). RPC and TUI omit this hook: they
			// stream the continuation through their own session subscription, and
			// blocking their command queue here would strand a follow-up `abort`.
			await runtime.keepTurnOpenUntilIdle?.();
			// `retry()` returned true, so a real agent turn is now scheduled — RPC
			// hosts must not be told this was local-only work.
			return commandConsumed({ agentInvoked: true });
		},
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("没有可重试的内容");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "debug",
		icon: "bug",
		description: "打开调试工具选择器",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		icon: "memory",
		description: "查看和维护记忆数据",
		acpDescription: "管理记忆",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "查看当前注入的记忆内容" },
			{ name: "stats", description: "查看记忆后端统计" },
			{ name: "diagnose", description: "运行记忆后端诊断" },
			{ name: "queue", description: "查看等待整理的记忆增量" },
			{ name: "sync", description: "立即执行记忆整理" },
			{ name: "clear", description: "清空已保存的记忆数据和产物" },
			{ name: "reset", description: "同 clear" },
			{ name: "enqueue", description: "排队执行记忆整理维护" },
			{ name: "rebuild", description: "同 enqueue" },
			{ name: "mm list", description: "列出当前库上的心智模型" },
			{ name: "mm show", description: "查看一个心智模型（需 id）" },
			{
				name: "mm refresh",
				description: "刷新全部或指定 id 的心智模型",
			},
			{ name: "mm history", description: "查看心智模型的修改历史" },
			{ name: "mm seed", description: "补建缺失的内置心智模型" },
			{ name: "mm delete", description: "从库中删除一个心智模型（需 id）" },
			{ name: "mm reload", description: "重新拉取缓存的心智模型块" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "queue": {
					const payload = await backend.queuePreview?.({
						agentDir: runtime.settings.getAgentDir(),
						cwd: runtime.cwd,
						session: runtime.session,
					});
					await runtime.output(payload ?? `后端 ${backend.id} 不支持记忆队列。`);
					return commandConsumed();
				}
				case "sync": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("记忆整理已完成。");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("用法：/memory <view|stats|diagnose|clear|reset|enqueue|rebuild|queue|sync>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		icon: "pencil",
		description: "重命名当前会话（省略标题则自动生成）",
		inlineHint: "[title]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const session = runtime.session;
			const sessionManager = runtime.sessionManager;
			const runRename = async (): Promise<void> => {
				const sessionId = sessionManager.getSessionId();
				const titleSignal = session.titleGenerationSignal;
				let titleRevision = sessionManager.titleRevision;
				const isCurrent = () =>
					runtime.session === session &&
					runtime.sessionManager === sessionManager &&
					!runtime.signal?.aborted &&
					!titleSignal.aborted &&
					sessionManager.getSessionId() === sessionId &&
					sessionManager.titleRevision === titleRevision;
				try {
					const generation = command.args || generateRenameTitle(session, runtime.signal);
					titleRevision = sessionManager.titleRevision;
					const title = typeof generation === "string" ? generation : await generation;
					if (!isCurrent() || title === undefined) return;
					if (!title) {
						await runtime.output("无法生成会话标题。请用 /rename <标题> 手动设置。");
						return;
					}
					const persistence = sessionManager.setSessionName(title, "user");
					titleRevision = sessionManager.titleRevision;
					const ok = await persistence;
					if (!isCurrent()) return;
					if (!ok) {
						await runtime.output("会话名称未更改（用户手动设置的名称优先）。");
						return;
					}
					await runtime.notifyTitleChanged?.();
					if (!isCurrent()) return;
					await runtime.output(`会话已重命名为 ${title}。`);
				} catch (err) {
					if (!isCurrent()) return;
					if (command.args || !runtime.runCommandInBackground) throw err;
					await runtime.output(`重命名失败：${errorMessage(err)}`);
				}
			};
			if (!command.args && runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runRename);
				return commandConsumed();
			}
			await runRename();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const session = runtime.ctx.session;
			const sessionManager = runtime.ctx.sessionManager;
			const sessionId = sessionManager.getSessionId();
			const titleSignal = session.titleGenerationSignal;
			const generation = command.args.trim() || generateRenameTitle(session);
			const titleRevision = sessionManager.titleRevision;
			const title = typeof generation === "string" ? generation : await generation;
			if (
				runtime.ctx.session !== session ||
				runtime.ctx.sessionManager !== sessionManager ||
				titleSignal.aborted ||
				sessionManager.getSessionId() !== sessionId ||
				sessionManager.titleRevision !== titleRevision ||
				title === undefined
			)
				return;
			if (!title) {
				runtime.ctx.showStatus("无法生成会话标题。请用 /rename <标题> 手动设置。");
				return;
			}
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		icon: "folderMove",
		description: "把当前会话移到其他目录",
		acpDescription: "移动当前会话",
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("用法：/move <path>", runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}`, runtime);
			}
			const failure = await relocateHeadlessSession(runtime, resolvedPath);
			if (failure) return failure;
			await runtime.output(`Moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "wt",
		aliases: ["worktree"],
		icon: "folderMove",
		description: "把本会话（连同改动）移动到新的 worktree",
		acpDescription: "把本会话（连同改动）移动到新的 worktree",
		inlineHint: "[<branch>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("流式输出期间无法创建 worktree。", runtime);
			const branch = command.args.trim() || defaultSessionWorktreeBranch();
			const sourceCwd = runtime.sessionManager.getCwd();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(sourceCwd, runtime.settings, branch);
			} catch (err) {
				return usage(`创建 worktree 失败：${errorMessage(err)}`, runtime);
			}
			const failure = await relocateHeadlessSession(runtime, worktree.path);
			if (failure) return failure;
			const cleanup = await cleanSourceCheckoutIfConfigured(sourceCwd, runtime.settings);
			if (cleanup.errorMessage !== undefined) {
				await runtime.output(`警告：worktree 已创建，但清理源检出失败：${cleanup.errorMessage}`);
			}
			await runtime.output(formatSessionWorktreeSummary(worktree, cleanup.cleaned));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleWorktreeCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		icon: "folderPlus",
		description: "给本会话添加一个工作目录（多目录）",
		acpDescription: "添加工作目录",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot add a directory while streaming.", runtime);
			if (!command.args) return usage(formatWorkspaceDirectories(runtime, "用法：/add-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(`Not a directory: ${resolved}`, runtime);
			} catch {
				return usage(`Directory does not exist: ${resolved}`, runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(`Already in the workspace: ${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Added ${added}.`));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		icon: "folderMinus",
		description: "从本会话移除一个工作目录",
		acpDescription: "移除工作目录",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot remove a directory while streaming.", runtime);
			if (!command.args) return usage("用法：/remove-dir <path>", runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage("Cannot remove the working directory; use /move to change it.", runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(`Not a workspace directory: ${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Removed ${removed}.`));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: "列出本会话的工作目录",
		acpDescription: "列出工作目录",
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: "退出程序",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "restart",
		icon: "restart",
		description: "使用相同的启动参数重启 omp，并恢复本会话",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.restart();
		},
	},
];
async function rescopeHeadlessToCwd(runtime: SlashCommandRuntime, cwd: string): Promise<void> {
	setProjectDir(cwd);
	await runtime.settings.reloadForCwd(cwd);
	await rebindMemoryBackendForCwd(runtime.session);
	applyProviderGlobalsFromSettings(runtime.settings);
	clearClaudePluginRootsCache();
	const src = discoverTitleSystemPromptFile(cwd);
	const p = await resolvePromptInput(src, "title system prompt");
	runtime.session.setTitleSystemPrompt(p);
	resetCapabilities();
	await runtime.session.refreshSkills();
	const cmds = await loadSlashCommands({
		cwd,
		extensionRoots: runtime.session.effectiveExtensionRoots,
	});
	runtime.session.setSlashCommands(cmds);
	await runtime.refreshCommands?.();
	await runtime.reloadPlugins();
}
