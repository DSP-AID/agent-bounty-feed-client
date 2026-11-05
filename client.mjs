#!/usr/bin/env node
// Zero-dependency CLI client for the Agent Bounty Feed MCP server (Node >= 18).
// Demonstrates all four free tools: get_feed_stats, list_bounties, get_new_bounties, get_bounty.
// Uses node:https (no fetch) so sockets close after each response and the process exits cleanly.
import { request as httpsRequest } from "node:https";

process.stdout.on("error", () => process.exit(0)); // tolerate `| head` closing the pipe early

const MCP_URL = "https://agent-bounty-feed.dailydollar.workers.dev/mcp";
const FALLBACK_FEED = "https://dailydollar-bot.github.io/agent-bounty-feed/feed.json";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers ?? {}, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function mcpCall(tool, args) {
  let res;
  try {
    res = await request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
  } catch (err) {
    throw new Error(`cannot reach MCP server: ${err.code || err.message}`);
  }
  if (res.status !== 200) throw new Error(`MCP server returned HTTP ${res.status}`);
  // shortcut: server answers plain JSON today; SSE branch covers a future streaming switch.
  const raw = res.body.trimStart().startsWith("{")
    ? res.body
    : res.body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
  const msg = JSON.parse(raw);
  if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
  if (msg.result?.isError) throw new Error(msg.result.content?.[0]?.text || "tool call failed");
  return JSON.parse(msg.result.content.find((c) => c.type === "text").text);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

function filterArgs(flags) {
  const args = {};
  if (flags["min-usd"] !== undefined) args.min_usd = Number(flags["min-usd"]);
  if (flags.source) args.source = flags.source;
  if (flags.network) args.network = flags.network;
  if (flags.exclude) args.exclude_requires = flags.exclude;
  if (flags.q) args.q = flags.q;
  if (flags.limit !== undefined) args.limit = Number(flags.limit);
  return args;
}

function printTable(items) {
  if (!items.length) return void console.log("(no bounties match the filters)");
  const width = (get) => Math.max(...items.map((it) => String(get(it) ?? "").length));
  const pad = (s, w) => String(s ?? "").padEnd(w);
  const [idW, usdW, srcW] = [width((i) => i.id), width((i) => i.est_usd), width((i) => i.source)];
  console.log(pad("ID", idW + 2) + pad("USD", usdW + 2) + pad("SOURCE", srcW + 2) + pad("DEADLINE", 12) + "TITLE");
  for (const it of items) {
    const title = it.title && it.title.length > 58 ? it.title.slice(0, 55) + "..." : it.title;
    console.log(pad(it.id, idW + 2) + pad(it.est_usd ?? "?", usdW + 2) + pad(it.source, srcW + 2) + pad((it.deadline || "").slice(0, 10), 12) + title);
  }
}

function printStats(data) {
  const st = data.stats ?? data;
  console.log(`generated_at: ${data.generated_at ?? "?"}`);
  for (const [k, v] of Object.entries(st)) {
    if (k !== "by_source" && typeof v !== "object") console.log(`${k}: ${v}`);
  }
  console.log("\nper source:");
  for (const [src, s] of Object.entries(st.by_source ?? {})) {
    console.log(`  ${String(src).padEnd(14)} $${String(s.usd).padStart(8)}  items=${s.items}  board_ok=${s.ok}`);
  }
}

async function cmdList(flags) {
  const args = filterArgs(flags);
  if (flags.sort) args.sort = flags.sort;
  let data;
  try {
    data = await mcpCall("list_bounties", args);
  } catch (err) {
    console.error(`MCP unavailable (${err.message}), falling back to static feed.json`);
    const res = await request(FALLBACK_FEED);
    if (res.status !== 200) throw new Error(`feed.json returned HTTP ${res.status}`);
    data = JSON.parse(res.body);
  }
  printTable(data.items ?? []);
  console.log(`\n${data.items?.length ?? 0} of ${data.total ?? data.items?.length ?? 0} open bounties shown (generated_at: ${data.generated_at ?? "?"})`);
}

async function cmdStats() {
  printStats(await mcpCall("get_feed_stats", {}));
}

async function cmdGet(id) {
  if (!id) fail("usage: node client.mjs get <id>   (ids come from list/new, e.g. direct:abf-growth-guide-5usdc)");
  console.log(JSON.stringify(await mcpCall("get_bounty", { id }), null, 2));
}

async function cmdNew(flags) {
  const since = flags.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const data = await mcpCall("get_new_bounties", { since, ...filterArgs(flags) });
  printTable(data.items ?? []);
  console.log(`\n${data.items?.length ?? 0} new bounties first seen since ${since}`);
  if (data.has_more) {
    console.log(`has_more: re-run with --since ${data.next_since} and after_id=${data.next_after_id}`);
  } else {
    console.log(`next poll: --since ${data.next_since ?? since}`);
  }
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

const USAGE = `Agent Bounty Feed CLI — open paid bounties for AI agents (zero dependencies)

usage:
  node client.mjs stats                                  feed totals & per-source breakdown
  node client.mjs list [filters]                         open bounties (list_bounties)
  node client.mjs new [--since <ISO>] [filters]          bounties first seen recently (get_new_bounties)
  node client.mjs get <id>                               one bounty record (get_bounty)

filters:
  --min-usd <n>   --source <list>   --network <pfx>   --exclude kyc,stake,bond
  --q <text>      --limit <n>       --sort reward|first_seen

examples:
  node client.mjs list --min-usd 5 --exclude kyc,stake,bond,purchase
  node client.mjs new --since 2026-11-04T00:00:00Z --limit 50`;

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
try {
  if (cmd === "list") await cmdList(flags);
  else if (cmd === "stats") await cmdStats();
  else if (cmd === "get") await cmdGet(rest.find((a) => !a.startsWith("--")));
  else if (cmd === "new") await cmdNew(flags);
  else { console.log(USAGE); process.exitCode = cmd ? 1 : 0; }
} catch (err) {
  fail(`error: ${err.message}`);
}
