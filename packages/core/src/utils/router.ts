import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@CCR/shared";
import { LRUCache } from "lru-cache";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (
            contentPart.type === "thinking" &&
            typeof contentPart.thinking === "string"
          ) {
            tokenCount += enc.encode(contentPart.thinking).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig?.Router) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig?.Router) {
          return projectConfig.Router;
        }
      } catch {}
    }
  }
  return undefined; // Return undefined to use original configuration
};

const extractMessageText = (
  content: string | ContentBlockParam[] | undefined
) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
};

const hasTeamLeadTeammatePayload = (messages: MessageParam[] | undefined) => {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = extractMessageText(message.content);
    if (text.includes('<teammate-message teammate_id="team-lead"')) {
      return true;
    }
  }
  return false;
};

interface ProviderConfig {
  name?: string;
  models?: string[];
}

const isKnownProviderModel = (
  providers: ProviderConfig[],
  providerModel: string
) => {
  const [providerName, ...modelParts] = providerModel.split(",");
  if (!providerName || modelParts.length === 0) return false;

  const modelName = modelParts.join(",");
  const provider = providers.find(
    (item) =>
      typeof item?.name === "string" &&
      item.name.toLowerCase() === providerName.toLowerCase()
  );
  if (!provider || !Array.isArray(provider.models)) return false;

  return provider.models.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.toLowerCase() === modelName.toLowerCase()
  );
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined
): Promise<{ model: string; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<ProviderConfig[]>("providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");
  const hasTeamLeadPayload = hasTeamLeadTeammatePayload(req.body?.messages);

  // Subagent model routing — HIGHEST priority, checked before comma-in-model.
  // Only scan system entries (NOT messages) to prevent routing leaks.
  for (const entry of req.body?.system ?? []) {
    if (!entry?.text) continue;
    if (!entry.text.includes("<CCR-SUBAGENT-MODEL>")) continue;

    const match = entry.text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (!match) continue;

    entry.text = entry.text.replace(match[0], "");
    const candidateModel = match[1].trim();

    if (
      !candidateModel ||
      candidateModel.includes("`") ||
      candidateModel.includes("\\")
    ) {
      req.log.warn("Ignoring malformed subagent model tag");
      continue;
    }

    if (hasTeamLeadPayload) {
      req.log.warn(
        `Ignoring leaked subagent model tag due to team-lead payload: ${candidateModel}`
      );
      continue;
    }

    if (!isKnownProviderModel(providers, candidateModel)) {
      req.log.warn(`Ignoring unknown subagent model tag: ${candidateModel}`);
      continue;
    }

    req.log.info(`Using subagent model: ${candidateModel}`);
    return { model: candidateModel, scenarioType: 'default' };
  }

  const rawModel = req.body.model;
  const globalRouter = configService.get("Router");

  // Capability-based routing takes priority over model-based routing.
  // webSearch must be checked before background, because Claude Code
  // sends web search requests using Haiku models.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    return { model: Router.webSearch, scenarioType: 'webSearch' };
  }

  const longContextThreshold = Router?.longContextThreshold || 60000;
  const lastUsagePromptTokens =
    (lastUsage?.input_tokens || 0) +
    (lastUsage?.cache_creation_input_tokens || 0) +
    (lastUsage?.cache_read_input_tokens || 0);
  const lastUsageThreshold = lastUsagePromptTokens > longContextThreshold;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  req.log.info(
    `LongContext decision metrics: tokenCount=${tokenCount}, lastUsage.input=${lastUsage?.input_tokens || 0}, lastUsage.cacheCreation=${lastUsage?.cache_creation_input_tokens || 0}, lastUsage.cacheRead=${lastUsage?.cache_read_input_tokens || 0}, lastUsagePromptTokens=${lastUsagePromptTokens}, threshold=${longContextThreshold}`
  );
  if ((lastUsageThreshold || tokenCountThreshold) && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return { model: Router.longContext, scenarioType: 'longContext' };
  }

  if (rawModel?.includes("claude") && rawModel?.includes("haiku")) {
    const hasTools = Array.isArray(req.body.tools) && req.body.tools.length > 0;
    if (!hasTools && globalRouter?.titleSummary) {
      req.log.info(`Using titleSummary model for ${rawModel}`);
      return { model: globalRouter.titleSummary, scenarioType: 'titleSummary' };
    }
    if (globalRouter?.background) {
      req.log.info(`Using background model for ${rawModel}`);
      return { model: globalRouter.background, scenarioType: 'background' };
    }
  }

  if (req.body.thinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return { model: Router.think, scenarioType: 'think' };
  }

  // --- Explicit provider,model resolution ---
  if (rawModel.includes(",")) {
    const [provider, model] = rawModel.split(",");
    const finalProvider = providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return { model: `${finalProvider.name},${finalModel}`, scenarioType: 'default' };
    }
    return { model: rawModel, scenarioType: 'default' };
  }

  return { model: Router?.default, scenarioType: 'default' };
};

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'titleSummary' | 'think' | 'longContext' | 'webSearch';

export interface RouterFallbackConfig {
  default?: string[];
  background?: string[];
  titleSummary?: string[];
  think?: string[];
  longContext?: string[];
  webSearch?: string[];
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, event } = context;
  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  // Token counting: isolated so failures don't affect model routing
  let tokenCount = 0;
  try {
    // Try to get tokenizer config for the current model
    const [providerName, modelName] = req.body.model.split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }
  } catch (tokenError: any) {
    req.log.warn(`Token counting failed (using 0): ${tokenError.message}`);
  }

  try {
    let model;
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage);
      model = result.model;
      req.scenarioType = result.scenarioType;
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      req.scenarioType = 'default';
    }
    req.body.model = model;
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    const Router = configService.get("Router");
    req.body.model = Router?.default;
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses LRU cache with max 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    return result || null;
  }

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    // Concurrently check each project folder for sessionId.jsonl file
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File does not exist, continue checking next
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    return null;
  }
};
