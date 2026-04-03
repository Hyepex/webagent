/**
 * WebAgent MCP Server
 *
 * Exposes three tools:
 *   search_recipes  — match a natural-language query to available recipes
 *   execute_recipe  — run a recipe with supplied variables
 *   list_recipes    — return all available recipes with their variable schemas
 *
 * Transports:
 *   stdio (default) — for Claude Desktop and MCP CLI clients
 *   SSE             — start with --sse [port] for HTTP/SSE clients (e.g. Intrkt)
 */

"use strict";

const http = require("http");
const path = require("path");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const config = require("./config");
const BrowserController = require("./browser/controller");
const { executeRecipe } = require("./recipes/executor");
const { matchRecipe, mergeVariables } = require("./recipes/matcher");
const { getRecipes, getRecipeById } = require("./recipes/store");
const { createLogger } = require("./utils/logger");

const log = createLogger("mcp-server");

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_recipes",
    description: "Find recipes that match a natural-language task description. Returns matching recipes with their IDs and variable schemas so you can call execute_recipe.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of what you want to do (e.g. 'find flights from Mumbai to Delhi')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "execute_recipe",
    description: "Execute a recipe by ID with the required variables. Returns structured results on success, or a structured error with the failed step details.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: {
          type: "string",
          description: "The recipe ID to execute (get this from search_recipes or list_recipes)",
        },
        variables: {
          type: "object",
          description: "Key-value pairs for the recipe variables. Check the recipe's variables schema for required fields.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["recipe_id"],
    },
  },
  {
    name: "list_recipes",
    description: "List all available recipes with their IDs, descriptions, tags, and variable schemas.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ─── Request Queue ───────────────────────────────────────────────────────────
// Sequential execution — concurrent requests are queued to avoid browser conflicts.

let _queueTail = Promise.resolve();

function enqueue(fn) {
  const result = _queueTail.then(fn);
  _queueTail = result.catch(() => {});
  return result;
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────

async function handleSearchRecipes({ query }) {
  if (!query || typeof query !== "string") {
    return { content: [{ type: "text", text: "Error: query must be a non-empty string" }], isError: true };
  }

  const match = await matchRecipe(query);
  if (!match) {
    const all = await getRecipes();
    const names = all.map(r => `• ${r.name} (${r.id})`).join("\n");
    return {
      content: [{
        type: "text",
        text: `No recipe matched "${query}".\n\nAvailable recipes:\n${names}`,
      }],
    };
  }

  const { recipe, score, variables } = match;
  const varSchema = Object.entries(recipe.variables || {})
    .map(([k, v]) => `  ${k}: ${v.required ? "(required)" : "(optional)"} — ${v.label || ""}`)
    .join("\n");

  const text = [
    `Matched: ${recipe.name} (id: ${recipe.id}, score: ${score.toFixed(2)})`,
    "",
    "Variables schema:",
    varSchema || "  (none)",
    "",
    "Extracted from query:",
    Object.keys(variables).length > 0
      ? Object.entries(variables).map(([k, v]) => `  ${k}: "${v}"`).join("\n")
      : "  (none — you must supply variables)",
    "",
    `Call execute_recipe with recipe_id="${recipe.id}" and the required variables.`,
  ].join("\n");

  return { content: [{ type: "text", text }] };
}

async function handleListRecipes() {
  const recipes = await getRecipes();
  if (recipes.length === 0) {
    return { content: [{ type: "text", text: "No recipes available." }] };
  }

  const lines = recipes.map(r => {
    const tags = (r.tags || []).join(", ");
    const vars = Object.entries(r.variables || {})
      .map(([k, v]) => `${k}${v.required ? "*" : ""}`)
      .join(", ");
    return [
      `## ${r.name}`,
      `id: ${r.id}${tags ? `  |  tags: ${tags}` : ""}`,
      vars ? `variables: ${vars}  (* = required)` : "variables: none",
    ].join("\n");
  });

  return { content: [{ type: "text", text: lines.join("\n\n") }] };
}

async function handleExecuteRecipe(browser, { recipe_id, variables = {} }) {
  if (!recipe_id) {
    return { content: [{ type: "text", text: "Error: recipe_id is required" }], isError: true };
  }

  const recipe = await getRecipeById(recipe_id);
  if (!recipe) {
    return {
      content: [{ type: "text", text: `Error: no recipe found with id "${recipe_id}". Use list_recipes to see available recipes.` }],
      isError: true,
    };
  }

  // Merge variables with recipe defaults
  const mergedVars = mergeVariables(variables, {}, recipe);

  // Check required variables are present
  const missing = [];
  for (const [key, def] of Object.entries(recipe.variables || {})) {
    if (def.required && !mergedVars[key]) missing.push(key);
  }
  if (missing.length > 0) {
    return {
      content: [{ type: "text", text: `Error: missing required variables: ${missing.join(", ")}` }],
      isError: true,
    };
  }

  log.info(`execute_recipe: ${recipe_id} vars=${JSON.stringify(variables)}`);

  // Execute in the queue — one at a time
  const execResult = await enqueue(async () => {
    await browser.createTaskContext();
    try {
      return await executeRecipe(recipe, mergedVars, browser, {});
    } finally {
      await browser.closeTaskContext().catch(() => {});
    }
  });

  if (execResult.success) {
    return { content: [{ type: "text", text: execResult.result }] };
  }

  // Structured error
  const failStep = execResult.steps?.find(s => s.failed && !s.optional);
  const errText = [
    `Recipe failed at step ${execResult.failed_at_step}: ${execResult.result}`,
    failStep ? `Action: ${failStep.action}` : null,
    failStep?.page_url ? `Page URL: ${failStep.page_url}` : null,
    failStep?.page_title ? `Page title: ${failStep.page_title}` : null,
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: errText }], isError: true };
}

// ─── MCP Server Factory ──────────────────────────────────────────────────────

function createMcpServer(browser) {
  const server = new Server(
    { name: "webagent", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    log.info(`Tool call: ${name}`);

    switch (name) {
      case "search_recipes":
        return handleSearchRecipes(args);
      case "list_recipes":
        return handleListRecipes();
      case "execute_recipe":
        return handleExecuteRecipe(browser, args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  });

  return server;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const useSSE = args.includes("--sse");
  const ssePort = parseInt(args[args.indexOf("--sse") + 1]) || config.server?.port || 3000;

  log.info(`Starting WebAgent MCP server (${useSSE ? `SSE on port ${ssePort}` : "stdio"})`);

  // Launch browser
  config.browser.headless = true;
  const browser = new BrowserController();
  await browser.launch();
  log.info("Browser ready");

  const gracefulShutdown = async () => {
    log.info("Shutting down...");
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  if (useSSE) {
    // SSE transport — minimal HTTP server, no Express
    const transports = new Map(); // sessionId → transport

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${ssePort}`);

      if (req.method === "GET" && url.pathname === "/sse") {
        const server = createMcpServer(browser);
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        res.on("close", () => transports.delete(transport.sessionId));
        await server.connect(transport);

      } else if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404).end("Session not found");
          return;
        }
        await transport.handlePostMessage(req, res);

      } else {
        res.writeHead(404).end("Not found");
      }
    });

    httpServer.listen(ssePort, () => {
      log.info(`SSE endpoint: http://localhost:${ssePort}/sse`);
    });

  } else {
    // stdio transport
    const server = createMcpServer(browser);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("Connected via stdio");
  }
}

main().catch(err => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
