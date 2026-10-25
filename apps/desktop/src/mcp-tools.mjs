/**
 * A tiny MCP client for the app's own agent (Pi).
 *
 * The external agents connect to OpenFilm's MCP server through ACP's `mcpServers`; Pi's SDK has no
 * such switch, so this module turns the same server into Pi tools. It speaks only the parts of MCP
 * OpenFilm uses: initialize, tools/list and tools/call over HTTP JSON-RPC. A server that cannot be
 * reached is skipped; the conversation still opens, and the person can reconnect it.
 */

let nextId = 1;

/** @param {string} url @param {Array<{ name: string, value: string }>} headers @param {any} body */
async function rpc(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...Object.fromEntries((headers ?? []).filter((h) => h && typeof h.name === 'string').map((h) => [h.name, String(h.value ?? '')])),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${response.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch {
    /* Some MCP transports frame a JSON-RPC answer as Server-Sent Events. */
    const line = text.split(/\r?\n/).find((item) => item.startsWith('data:'));
    if (!line) throw new Error('MCP returned neither JSON nor an SSE data line');
    return JSON.parse(line.slice(5).trim());
  }
}

function textOf(/** @type {any} */ result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.map((/** @type {any} */ block) => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n');
}

/**
 * The tools of every HTTP MCP server the session was given, in Pi's tool shape.
 * @param {Array<{ type?: string, name?: string, url?: string, headers?: Array<{ name: string, value: string }> }>} servers
 */
export async function mcpTools(servers) {
  const tools = [];
  const owners = new Map();
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || server.type !== 'http' || !server.url || !server.name) continue;
    try {
      const init = await rpc(server.url, server.headers ?? [], {
        jsonrpc: '2.0', id: nextId++, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openfilm-pi', version: '1.0.0' } },
      });
      if (init?.error) throw new Error(init.error.message ?? 'initialize failed');
      const listed = await rpc(server.url, server.headers ?? [], { jsonrpc: '2.0', id: nextId++, method: 'tools/list' });
      if (listed?.error) throw new Error(listed.error.message ?? 'tools/list failed');
      for (const tool of Array.isArray(listed?.result?.tools) ? listed.result.tools : []) {
        if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
        const parameters = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
        const owner = { url: server.url, headers: server.headers ?? [] };
        if (owners.has(tool.name)) continue;
        owners.set(tool.name, owner);
        tools.push({
          name: tool.name,
          label: tool.title || tool.name,
          description: tool.description || `OpenFilm tool ${tool.name}`,
          parameters,
          execute: async (_toolCallId, args) => {
            const answer = await rpc(owner.url, owner.headers, {
              jsonrpc: '2.0', id: nextId++, method: 'tools/call',
              params: { name: tool.name, arguments: args && typeof args === 'object' ? args : {} },
            });
            if (answer?.error) throw new Error(answer.error.message ?? `${tool.name} failed`);
            const text = textOf(answer?.result);
            if (answer?.result?.isError) throw new Error(text || `${tool.name} failed`);
            return { content: [{ type: 'text', text: text || `${tool.name} completed.` }], details: {} };
          },
        });
      }
    } catch (error) {
      process.stderr.write(`MCP ${server.name}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return { tools, names: tools.map((tool) => tool.name) };
}
