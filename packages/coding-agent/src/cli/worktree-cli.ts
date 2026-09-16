/**
 * CLI handler for `omp worktree` — list and clean up agent-managed worktrees.
 *
 * Layout under `~/.omp/wt/`:
 *
 *   - **PR-checkout worktrees** (`tools/gh.ts`): a regular git worktree dir
 *     containing a `.git` *file* that points back at
 *     `<parent-repo>/.git/worktrees/<name>/`.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. `ensureIsolation` writes an ownership
 *     marker naming the live omp process; a
 *     sandbox whose owner is still running is reported `live` and never
 *     removed without `--all`, so `clear` reclaims only crashed leftovers.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { hasLiveIsolationOwner, ISOLATION_OWNER_FILE, readRetainedMountBackend } from "../task/isolation-ownership";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";

type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.omp/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `omp worktree clear` will remove it. */
	orphanReason?: string;
}

export interface AddWorktreeOptions {
	cwd?: string;
	path: string;
	commit?: string;
	branch?: string;
	forceBranch?: string;
	detach: boolean;
	quiet: boolean;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every entry, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}
/**
 * Run native teardown on a retained workspace before recursive removal.
 * Recursive `rm` through a live overlay mount destroys the preserved upper
 * layer entry by entry and then fails on the mountpoint itself (likewise a
 * Btrfs subvolume root, removable only via subvolume delete) — and mounts
 * survive the owning session, so the reclaim path (unlike teardown) cannot
 * rely on the creator to stop them. Side-effect-free without a retained-
 * backend sidecar (returns false); throws when the sidecar cannot be read
 * or teardown itself fails, so the caller skips removal instead of
 * traversing a possibly live mount — the entry is then reported failed
 * with the error, data intact.
 */
export async function stopRetainedMount(dir: string): Promise<boolean> {
	const backend = await readRetainedMountBackend(dir);
	if (backend === undefined) return false;
	for (const name of TASK_ISOLATION_MOUNT_DIRS) {
		const candidate = path.join(dir, name);
		if (
			await fs
				.stat(candidate)
				.then(stat => stat.isDirectory())
				.catch(() => false)
		) {
			await natives.isoStop(backend, candidate);
			return true;
		}
	}
	return false;
}

export async function addWorktree(options: AddWorktreeOptions): Promise<void> {
	if (options.branch && options.forceBranch) {
		throw new Error("fatal: 选项 '-b' 和 '-B' 不能同时使用");
	}
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const repository = vcs.requireGit(cwd);
	const worktreePath = path.resolve(cwd, options.path);
	try {
		const stat = await fs.stat(worktreePath);
		const nonEmpty = !stat.isDirectory() || (await fs.readdir(worktreePath)).length > 0;
		if (nonEmpty) throw new Error(`fatal: '${options.path}' 已存在`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const settings = await Settings.init({ cwd });
	let ref: string;
	let detach = false;
	let createdBranch: string | undefined;
	if (options.branch || options.forceBranch) {
		const branch = options.branch ?? options.forceBranch;
		if (!branch) throw new Error("必须指定分支名");
		await repository.createBranch(branch, options.commit ?? "HEAD", Boolean(options.forceBranch));
		ref = branch;
		createdBranch = branch;
	} else if (options.detach) {
		ref = options.commit ?? "HEAD";
		detach = true;
	} else if (options.commit) {
		ref = options.commit;
		detach = !(await repository.refExists(`refs/heads/${options.commit}`));
	} else {
		const branch = path.basename(worktreePath);
		if (!(await repository.refExists(`refs/heads/${branch}`))) {
			await repository.createBranch(branch, "HEAD", false);
			createdBranch = branch;
		}
		ref = branch;
	}

	const commit = await repository.commitDetails(ref);
	const shortSha = commit.sha.slice(0, 7);
	const subject = commit.message.split("\n", 1)[0];
	if (!options.quiet) {
		const preparation = createdBranch
			? `新分支 '${createdBranch}'`
			: detach
				? `分离 HEAD ${shortSha}`
				: `正在检出 '${ref}'`;
		console.log(`正在准备 worktree（${preparation}）`);
	}
	const result = await repository.worktreeAdd(worktreePath, ref, {
		detach,
		clone: settings.get("worktree.clone"),
		backend: parseIsolationBackend(settings.get("isolation.backend")),
	});
	if (!options.quiet) {
		console.log(`HEAD 现在位于 ${shortSha} ${subject}`);
		if (result.clonedWith != null) {
			console.log(`已通过 ${formatIsolationBackend(result.clonedWith)} 从 ${repository.info().repoRoot} 克隆`);
		}
	}
	if (result.cloneError) {
		console.error(chalk.dim(`warning: worktree 克隆已回退为普通检出：${result.cloneError}`));
	}
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`未在 ${getWorktreesDir()} 下找到代理管理的 worktree。`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason ? chalk.yellow("orphaned") : chalk.green("live    ");
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(`\n${live} 个存活 · ${orphaned} 个孤立 · 共 ${entries.length} 个`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<{ removed: number; failed: number }> {
	const entries = await scanWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "没有可移除的 worktree。" : "没有可移除的孤立 worktree。"));
		}
		return { removed: 0, failed: 0 };
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("将移除")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n将移除 ${targets.length} 个目录。`));
		}
		return { removed: 0, failed: 0 };
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
			if (target.kind === "pr-checkout" && target.parentRepo && !target.orphanReason) {
				// Live worktree: ask git to remove it cleanly. If git refuses (locked,
				// dirty, etc.), fall back to fs.rm and rely on `worktree prune` to
				// clean the bookkeeping on the parent side.
				const removed = await vcs.git(target.parentRepo)?.worktreeRemove(target.path, true);
				if (!removed) {
					await fs.rm(target.path, { recursive: true, force: true });
					parentsToPrune.add(target.parentRepo);
				}
			} else {
				if (target.kind === "task-isolation") await stopRetainedMount(target.path);
				await fs.rm(target.path, { recursive: true, force: true });
				if (target.parentRepo) parentsToPrune.add(target.parentRepo);
			}
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
	for (const parent of parentsToPrune) {
		try {
			await vcs.requireGit(parent).worktreePrune();
		} catch {
			/* parent repo may already be gone or pruned — ignore */
		}
	}

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		return { removed: succeeded, failed };
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green("已移除")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("失败  ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n已移除 ${succeeded} 个${failed > 0 ? ` · ${chalk.red(`${failed} 个失败`)}` : ""}`));
	return { removed: succeeded, failed };
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.omp/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.stat(childDir).catch(() => null);
			if (!childStat?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "空目录" : "无可识别的 worktree 内容",
			});
		}
	}
	return entries;
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.stat(gitEntry).catch(() => null);
	if (gitStat?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	// A task-isolation sandbox is identified by its ownership marker — written
	// before the backend materialises the mount — or by the `m`/`merged` mount
	// dir itself (legacy dirs and crashed pre-marker runs). Recognizing the
	// marker alone keeps an in-progress sandbox from being mistaken for a stray
	// during the window between marker creation and mount materialisation.
	let isIsolation = await Bun.file(path.join(dir, ISOLATION_OWNER_FILE)).exists();
	if (!isIsolation) {
		for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
			const mountStat = await fs.stat(path.join(dir, mountDir)).catch(() => null);
			if (mountStat?.isDirectory()) {
				isIsolation = true;
				break;
			}
		}
	}
	if (!isIsolation) return null;
	const live = await hasLiveIsolationOwner(dir);
	return {
		path: dir,
		kind: "task-isolation",
		// Only after confirming no live owner is the "no live task" claim true.
		// A running subagent's sandbox stays live so `clear` won't delete it.
		orphanReason: live ? undefined : "task-isolation 残留（没有存活的 task 占用）",
	};
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `无法读取 .git 文件：${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: ".git 文件格式错误（缺少 gitdir 行）" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await fs.stat(parentGitDir).catch(() => null);
	if (!parentDirStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "父仓库已不再跟踪此 worktree",
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "父仓库缺失",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "未知仓库";
		const branch = entry.branch ?? "未知分支";
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation 沙箱");
	} else if (entry.kind === "empty") {
		parts.push("旧版项目空壳");
	} else {
		parts.push("无法识别的内容");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" — ");
}
