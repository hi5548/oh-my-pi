import "@oh-my-pi/pi-utils/env";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

export function getExtraHelpText(): string {
	return `${chalk.bold("环境变量：")}
  ${chalk.dim("# 核心服务商")}
  ANTHROPIC_API_KEY          - Anthropic Claude 模型
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth（优先于 API key）
  CLAUDE_CODE_USE_FOUNDRY    - 启用 Anthropic Foundry 模式（使用 Foundry 端点和 mTLS）
  FOUNDRY_BASE_URL           - Anthropic Foundry 基础 URL（例如 https://<foundry-host>）
  ANTHROPIC_FOUNDRY_API_KEY  - Foundry 模式下作为 Authorization: Bearer <token> 使用的 Anthropic token
  ANTHROPIC_CUSTOM_HEADERS   - Foundry 或自定义 ANTHROPIC_BASE_URL 网关的额外请求头（例如 "user-id: USERNAME"）
  CLAUDE_CODE_CLIENT_CERT    - mTLS 使用的客户端证书（PEM 路径或内嵌 PEM）
  CLAUDE_CODE_CLIENT_KEY     - mTLS 使用的客户端私钥（PEM 路径或内嵌 PEM）
  NODE_EXTRA_CA_CERTS        - 用于验证服务器证书的 CA 证书包路径（或内嵌 PEM）
  OPENAI_API_KEY             - OpenAI GPT 模型
  GEMINI_API_KEY             - Google Gemini 模型
  COPILOT_GITHUB_TOKEN      - GitHub Copilot

	${chalk.dim("# 其他 LLM 服务商")}
	AZURE_OPENAI_API_KEY       - Azure OpenAI 模型
	GROQ_API_KEY               - Groq 模型
	CEREBRAS_API_KEY           - Cerebras 模型
	XAI_API_KEY                - xAI Grok 模型
	OPENROUTER_API_KEY         - OpenRouter 聚合模型
	KILO_API_KEY               - Kilo Gateway 模型
	MISTRAL_API_KEY            - Mistral 模型
	ZAI_API_KEY                - z.ai 模型（智谱 AI/GLM）
	UMANS_AI_CODING_PLAN_API_KEY - Umans AI Coding Plan 模型
	ABLITERATION_API_KEY       - Abliteration 无审查 GLM 模型
	UMANS_WEBSEARCH_PROVIDER    - Umans 网关网页搜索后端（native 或 exa）
	MINIMAX_API_KEY            - MiniMax 模型
	OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go 模型
	CURSOR_ACCESS_TOKEN        - Cursor AI 模型
	CLINE_API_KEY              - ClinePass 订阅模型
	COMMAND_CODE_API_KEY       - Command Code Provider API 模型
	CHARM_HYPER_API_KEY        - Charm Hyper 推理网关模型
  AI_GATEWAY_API_KEY         - Vercel AI Gateway
  WAFER_SERVERLESS_API_KEY   - Wafer Serverless（按用量付费）
  YOLO_AUTO_API_KEY          - Yolo-Auto 固定费率 Qwen 模型

  ${chalk.dim("# 云服务商")}
  AWS_PROFILE                - AWS Bedrock（或 AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY）
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI（需要 GOOGLE_CLOUD_LOCATION）
  GOOGLE_APPLICATION_CREDENTIALS - Vertex AI 使用的服务账号

	${chalk.dim("# 搜索与工具")}
	EXA_API_KEY                - Exa 网页搜索
	BRAVE_API_KEY              - Brave 网页搜索
	PERPLEXITY_API_KEY         - Perplexity 网页搜索 API key（可选；匿名备用）
	PERPLEXITY_COOKIES         - Perplexity 网页搜索（会话 Cookie）
	TAVILY_API_KEY             - Tavily 网页搜索
	TINYFISH_API_KEY           - TinyFish 网页搜索
	FIRECRAWL_API_KEY          - Firecrawl 网页搜索 + 阅读器抓取后端
	ANTHROPIC_SEARCH_API_KEY   - Anthropic 网页搜索（覆盖值；将搜索与主 ANTHROPIC_API_KEY 隔离）
	ANTHROPIC_SEARCH_BASE_URL  - Anthropic 网页搜索基础 URL（覆盖值；与 ANTHROPIC_SEARCH_API_KEY 配套）

  ${chalk.dim("# 配置")}
  OMP_PROFILE                 - 用于隔离代理状态的命名配置（同 --profile）
  使用 \`omp --profile <name> --alias <command>\` 为配置创建 Shell 快捷命令
  PI_CODING_AGENT_DIR        - 会话存储目录（默认：~/${CONFIG_DIR_NAME}/agent）
  PI_PACKAGE_DIR             - 覆盖包目录（用于 Nix/Guix 存储路径）
  PI_SMOL_MODEL              - 覆盖轻量/快速模型（参见 --smol）
  PI_SLOW_MODEL              - 覆盖慢速/推理模型（参见 --slow）
  PI_PLAN_MODEL              - 覆盖规划模型（参见 --plan）
  PI_NO_PTY                  - 禁用基于 PTY 的交互式 bash 执行
  完整的环境变量参考请参见：
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("可用工具（除非特别注明，默认启用）：")}
  read          - 读取文件内容
  bash          - 执行 bash 命令
  edit          - 使用查找/替换编辑文件
  write         - 写入文件（创建或覆盖）
  grep          - 搜索文件内容
  glob          - 按 glob 模式查找文件
  lsp           - 语言服务器协议（代码智能）
  python        - 执行 Python 代码（需要：${APP_NAME} setup python）
  notebook      - 编辑 Jupyter notebook
  browser       - 浏览器自动化（Puppeteer）
  computer      - 原生主机桌面截图和输入（默认禁用）
  task          - 启动子代理并行处理任务
  todo          - 管理待办事项/任务列表
  web_search    - 搜索网页
  ask           - 询问用户问题（仅交互模式）

${chalk.bold("扩展选项：")}
  --plugin-dir <path>        从目录加载扩展（可重复指定）

${chalk.bold("实用命令：")}
  omp agents unpack           - 将内置子代理导出到 ~/.omp/agent/agents（默认）
  omp agents unpack --project - 将内置子代理导出到 ./.omp/agents`;
}
