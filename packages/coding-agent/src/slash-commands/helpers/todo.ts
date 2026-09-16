import type { TodoPhase } from "../../tools/todo";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/todo";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

type TodoMutationVerb = "done" | "drop" | "rm";

interface TodoTaskMatch {
	task: { content: string; status: string };
	phase: TodoPhase;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			current += input[++index];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	const exact = phases.find(phase => phase.name.toLowerCase() === normalizedQuery);
	if (exact) return exact;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(normalizedQuery));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(normalizedQuery));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): TodoTaskMatch | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === normalizedQuery) return { task, phase };
		}
	}
	const matches: TodoTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(normalizedQuery)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const active = matches.filter(match => match.task.status === "in_progress" || match.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

function currentPhases(runtime: SlashCommandRuntime): TodoPhase[] {
	const fromEntries = getLatestTodoPhasesFromEntries(runtime.sessionManager.getBranch());
	return fromEntries.length > 0 ? fromEntries : runtime.session.getTodoPhases();
}

function commitTodos(runtime: SlashCommandRuntime, phases: TodoPhase[]): void {
	runtime.session.setTodoPhases(phases);
	runtime.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
}

const TODO_HELP_TEXT = [
	"用法：/todo <verb> [args]",
	"  /todo                              显示当前待办",
	"  /todo edit                         （仅 TUI）在 $EDITOR 中打开",
	"  /todo copy                         以 Markdown 打印待办",
	"  /todo expand                       （仅 TUI）展开常驻 HUD",
	"  /todo collapse                     （仅 TUI）收起常驻 HUD",
	"  /todo export [<path>]              把待办写入文件（默认：TODO.md）",
	"  /todo import [<path>]              用文件内容替换待办（默认：TODO.md）",
	"  /todo append [<phase>] <task...>   追加一个任务",
	"  /todo start  <task>                把任务标记为 in_progress（模糊匹配）",
	"  /todo done   [<task|phase>]        把任务/阶段/全部标记为已完成",
	"  /todo drop   [<task|phase>]        把任务/阶段/全部标记为已放弃",
	"  /todo rm     [<task|phase>]        移除任务/阶段/全部",
].join("\n");

async function handleTodoCopyCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	await runtime.output(`ACP 模式下不支持复制，改为直接输出：\n\n${markdown || "暂无待办。"}`);
	return commandConsumed();
}

async function handleTodoExportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	if (phases.length === 0) {
		await runtime.output("没有可导出的待办。");
		return commandConsumed();
	}
	let target: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		await Bun.write(target, phasesToMarkdown(phases));
	} catch (err) {
		return usage(`写入待办失败：${errorMessage(err)}`, runtime);
	}
	await runtime.output(`待办已写入 ${target}`);
	return commandConsumed();
}

async function handleTodoImportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	let target: string;
	let content: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		content = await Bun.file(target).text();
	} catch (err) {
		return usage(`读取待办失败：${errorMessage(err)}`, runtime);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) return usage(`无法解析 ${target}：\n  ${errors.join("\n  ")}`, runtime);
	commitTodos(runtime, phases);
	const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	await runtime.output(`已从 ${target} 导入 ${phases.length} 个阶段、${taskCount} 个任务。`);
	return commandConsumed();
}

async function handleTodoAppendCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = tokenize(restArgs);
	if (tokens.length === 0) return usage("用法：/todo append [<phase>] <task...>", runtime);

	const current = currentPhases(runtime);
	const phaseName = tokens.length === 1 ? undefined : tokens[0];
	const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
	const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
	let targetPhase: TodoPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCaseWords(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1]!;
	} else {
		targetPhase = { name: "Todos", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });
	commitTodos(runtime, next);
	await runtime.output(`已追加到 ${targetPhase.name}：${finalContent}`);
	return commandConsumed();
}

async function handleTodoStartCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!restArgs) return usage("用法：/todo start <task>", runtime);
	const current = currentPhases(runtime);
	const query = tokenize(restArgs).join(" ") || restArgs;
	const hit = findTaskFuzzy(current, query);
	if (!hit) return usage(`没有匹配 "${restArgs}" 的任务。用 /todo 查看当前任务。`, runtime);
	const { phases } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
	commitTodos(runtime, phases);
	await runtime.output(`已开始：${hit.task.content}`);
	return commandConsumed();
}

async function handleTodoMutationCommand(
	verb: TodoMutationVerb,
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const current = currentPhases(runtime);
	const trimmedArg = restArgs.trim();
	if (!trimmedArg) {
		if (verb === "rm") {
			commitTodos(runtime, []);
			await runtime.output("已清空所有待办。");
			return commandConsumed();
		}
		const { phases } = applyOpsToPhases(current, [{ op: verb }]);
		commitTodos(runtime, phases);
		await runtime.output(verb === "done" ? "已将全部任务标记为完成。" : "已将全部任务标记为放弃。");
		return commandConsumed();
	}

	const taskHit = findTaskFuzzy(current, trimmedArg);
	if (taskHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, task: taskHit.task.content }]);
		commitTodos(runtime, phases);
		const label = verb === "done" ? "已标记完成" : verb === "drop" ? "已标记放弃" : "已移除";
		await runtime.output(`${label}: ${taskHit.task.content}`);
		return commandConsumed();
	}

	const phaseHit = findPhaseFuzzy(current, trimmedArg);
	if (phaseHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, phase: phaseHit.name }]);
		commitTodos(runtime, phases);
		const message =
			verb === "done"
				? `已将阶段 ${phaseHit.name} 标记为完成。`
				: verb === "drop"
					? `已将阶段 ${phaseHit.name} 标记为放弃。`
					: `已移除阶段：${phaseHit.name}`;
		await runtime.output(message);
		return commandConsumed();
	}

	return usage(`没有匹配 "${trimmedArg}" 的任务或阶段。`, runtime);
}

/** ACP/text-mode `/todo` handler. Shared by both dispatchers via the spec. */
export async function handleTodoAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const trimmed = command.args.trim();
	if (!trimmed) {
		const phases = currentPhases(runtime);
		await runtime.output(
			phases.length === 0 ? "暂无待办。用 /todo append <task> 添加一个。" : phasesToMarkdown(phases).trimEnd(),
		);
		return commandConsumed();
	}

	const { verb, rest } = parseSubcommand(trimmed);
	switch (verb) {
		case "copy":
			return await handleTodoCopyCommand(runtime);
		case "export":
			return await handleTodoExportCommand(rest, runtime);
		case "import":
			return await handleTodoImportCommand(rest, runtime);
		case "append":
			return await handleTodoAppendCommand(rest, runtime);
		case "start":
			return await handleTodoStartCommand(rest, runtime);
		case "done":
		case "drop":
		case "rm":
			return await handleTodoMutationCommand(verb, rest, runtime);
		case "edit":
			return usage("/todo edit 需要 TUI 编辑器；非交互式编辑请先用 /todo export 再用 /todo import。", runtime);
		case "expand":
		case "collapse":
			return usage(`/todo ${verb} 控制交互式 HUD，在当前模式下不可用。`, runtime);
		case "help":
		case "?":
			await runtime.output(TODO_HELP_TEXT);
			return commandConsumed();
		default:
			return usage("未知的 /todo 子命令。可用：append、start、done、drop、rm、copy、export、import。", runtime);
	}
}
