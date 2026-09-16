/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import backgroundJs from "../tools/browser/relay/extension-assets/background.js.txt" with { type: "text" };
import licenseText from "../tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import manifestJson from "../tools/browser/relay/extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "../tools/browser/relay/extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "../tools/browser/relay/extension-assets/options.js.txt" with { type: "text" };
import thirdPartyNotices from "../tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

const EXTENSION_FILES: Record<string, string> = {
	"background.js": backgroundJs,
	LICENSE: licenseText,
	"manifest.json": manifestJson,
	"options.html": optionsHtml,
	"options.js": optionsJs,
	"THIRD-PARTY-NOTICES.txt": thirdPartyNotices,
};

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = dirOverride ? path.resolve(dirOverride) : path.join(getBrowserRelayDir(), "extension");
	for (const name in EXTENSION_FILES) {
		await Bun.write(path.join(dir, name), EXTENSION_FILES[name]!);
	}
	console.log(`已把 OMP Browser Relay 扩展安装到 ${dir}`);
	console.log("");
	console.log("在 Chrome 中完成设置：");
	console.log("  1. 打开 chrome://extensions 并启用开发者模式。");
	console.log(`  2. 点击“加载已解压的扩展程序”，选择：${dir}`);
	console.log("  3. 启用该模式：  omp config set browser.relay true");
	console.log("");
	console.log("当浏览器预置脚本需要时，omp 会自动启动中继；");
	console.log("只有需要 --token 或 --no-group 时才自行运行 `omp browser-relay`。");
	console.log("扩展在连上中继后，徽章会显示 'on'。");
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	let relay: RelayServer;
	try {
		relay = startRelayServer({ port: args.port, token: args.token, group: args.group !== false, log });
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(`omp 浏览器中继已在 http://127.0.0.1:${args.port} 运行；无需操作。`);
				return;
			}
			console.error(`端口 ${args.port} 已被非 omp 浏览器中继的进程占用。`);
			process.exit(1);
		}
		throw err;
	}

	console.log(`omp 浏览器中继正在监听 http://127.0.0.1:${args.port}`);
	console.log(`  扩展端点  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  启用方式             omp config set browser.relay true");
	} else {
		console.log(
			`  启用方式             omp config set browser.relay true && omp config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log("正在等待 OMP Browser Relay 扩展连接（omp browser-relay install）...");

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log("扩展已连接。omp 浏览器预置脚本现在可以操控你的标签页了。");
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log("扩展已断开；正在等待它重新连接...");
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
