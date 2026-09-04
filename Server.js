'use strict';
// ╔══════════════════════════════════════════════════════════╗
// ║  Dynamic AxonMCP — v8.4 Production-Ready Final 🔒       ║                                      
// ║  Race-safe, memory-safe, injection-proof                 ║
// ║  Backward-compatible (args.arg → args.input fallback)    ║
// ║  Made in Azerbaijan 🇦🇿                                  ║
// ╚══════════════════════════════════════════════════════════╝

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const HOST = '127.0.0.1';
const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const WS   = path.join(HOME, 'mcp_dynamic_workspace');

// 🔧 Limits
const TM             = 60_000;
const MAX            = 8_000;
const MAX_BUF        = MAX * 2;
const BODY_LIMIT     = 1e6;
const MAX_TOOLS      = 50;
const MAX_SCRIPT_LEN = 64_000;
const MAX_CMD_LEN    = 10_000;
const MAX_INPUT_LEN  = 10_000;
const MAX_DESC_LEN   = 500;
const MAX_CONCURRENT = 5;
const SANDBOX        = false;

const TOOL_NAME_RE   = /^[a-z_][a-z0-9_-]*$/i;

if (!fs.existsSync(WS)) fs.mkdirSync(WS, { recursive: true });

const TOOLS_FILE = path.join(WS, '.mcp_tools.json');
const STATE_FILE = path.join(WS, '.mcp_state.json');

let cwd = WS;
try {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (s.cwd && fs.existsSync(s.cwd)) cwd = s.cwd;
} catch {}
const saveCwd = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ cwd })); } catch {}
};

let customTools = Object.create(null);
try {
  const raw = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
  for (const k of Object.keys(raw || {})) {
    const v = raw[k];
    if (TOOL_NAME_RE.test(k)
        && v
        && typeof v === 'object'
        && typeof v.name === 'string'
        && typeof v.desc === 'string'
        && typeof v.bash === 'string'
        && v.name === k) {
      customTools[k] = v;
    }
  }
} catch {}
const saveTools = () => {
  try {
    const plain = Object.create(null);
    for (const k of Object.keys(customTools)) plain[k] = customTools[k];
    fs.writeFileSync(TOOLS_FILE, JSON.stringify(plain, null, 2));
  } catch {}
};

const finalizeOutput = (head, tail, totalLen) => {
  if (totalLen <= MAX) return head;
  const separator = `\n...[${totalLen - MAX} simvol kəsildi]...\n`;
  const sepLen = separator.length;
  const available = MAX - sepLen;
  if (available <= 0) return separator;
  const halfH = Math.floor(available / 2);
  const halfT = available - halfH;
  const endSrc = tail.length > 0 ? tail : head;
  return head.slice(0, halfH) + separator + endSrc.slice(-halfT);
};

const makeBuffer = () => {
  let head = '', tail = '', total = 0;
  const push = (str) => {
    const s = String(str);
    total += s.length;
    if (head.length < MAX_BUF) {
      head += s;
      if (head.length > MAX_BUF) {
        tail = head.slice(MAX_BUF);
        head = head.slice(0, MAX_BUF);
      }
    } else {
      tail += s;
      if (tail.length > MAX_BUF) tail = tail.slice(-MAX_BUF);
    }
  };
  const result = () => finalizeOutput(head, tail, total);
  return { push, result };
};

let activeCmds = 0;

const execSpawn = (spawnArgs, execCwd) => new Promise((resolve, reject) => {
  if (activeCmds >= MAX_CONCURRENT) {
    return reject(new Error('System busy. Please wait.'));
  }
  activeCmds++;

  const outBuf = makeBuffer();
  const errBuf = makeBuffer();
  let done = false;

  const fin = v => {
    if (!done) {
      done = true;
      activeCmds--;
      resolve(v);
    }
  };

  const p = spawn(...spawnArgs, {
    cwd: execCwd,
    env: { ...process.env, HOME, TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', d => outBuf.push(d));
  p.stderr.on('data', d => errBuf.push(d));
  p.on('close', c => fin({
    c: c ?? 1,
    o: outBuf.result(),
    e: errBuf.result()
  }));
  p.on('error', x => fin({ c: 1, o: '', e: x.message }));
  const t = setTimeout(() => {
    try { p.kill('SIGKILL'); } catch {}
    fin({
      c: 124,
      o: outBuf.result(),
      e: errBuf.result() + '\n[TIMEOUT]'
    });
  }, TM);
  p.on('close', () => clearTimeout(t));
});

const run = (cmd, execCwd) => execSpawn(['bash', ['-c', cmd]], execCwd);
const runSafe = (script, input, execCwd) => execSpawn(
  ['bash', ['-c', `${script} "$1"`, '--', String(input ?? '')]],
  execCwd
);

const builtInTools = [
  {
    name: 'run',
    description: 'Execute shell commands and change working directory. ' +
                 'Examples: "ls -la", "cat file.txt", "mkdir test", "cd /path". ' +
                 'Use add_tool to create reusable bash scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Shell command to execute. Use "cd /path" to change directory.'
        }
      },
      required: ['cmd']
    }
  },
  {
    name: 'add_tool',
    description: 'Create a custom bash tool with argument passing. ' +
                 'The script receives input via $1 parameter. ' +
                 'Example: Create a "count" tool with bash: "wc -l $1" to count lines.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool identifier (alphanumeric, underscore, hyphen only). Example: "count_lines"'
        },
        desc: {
          type: 'string',
          description: `Brief usage description (max ${MAX_DESC_LEN} chars). Include examples.`
        },
        bash: {
          type: 'string',
          description: 'Bash script using $1 for input argument. Example: "cat $1 | wc -l"'
        }
      },
      required: ['name', 'desc', 'bash']
    }
  },
  {
    name: 'list_tools',
    description: 'List all available tools (built-in and custom). ' +
                 'Use this to discover what operations are available.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'rm_tool',
    description: 'Delete a custom tool by name. ' +
                 'Use list_tools first to see available custom tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool identifier to delete'
        }
      },
      required: ['name']
    }
  }
];

const reply = (id, content, isError = false) => ({
  jsonrpc: '2.0', id,
  result: { content: [{ type: 'text', text: String(content) }], isError }
});

const errorReply = (id, errorCode, errorMessage, details = null) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: {
    code: errorCode,
    message: errorMessage,
    data: details
  }
});

const wsBase = SANDBOX ? (WS.endsWith('/') ? WS : WS + '/') : null;

const handle = async ({ method, params, id }, reqCwd) => {
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dynamic-meta-mcp', version: '8.4-final' }
      }
    };
  }
  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    const dynamicTools = Object.keys(customTools).map(name => ({
      name,
      description: customTools[name].desc,
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: `Input argument for ${name} tool`
          }
        }
      }
    }));
    return { jsonrpc: '2.0', id, result: { tools: [...builtInTools, ...dynamicTools] } };
  }

  if (method === 'tools/call') {
    if (!params || typeof params !== 'object' || !params.name) {
      return errorReply(id, -32602, 'Invalid params: tool name required', {
        usage: '{name: "tool_name", arguments: {...}}'
      });
    }

    const { name, arguments: args } = params;

    if (name === 'run') {
      const cmd = args?.cmd;
      if (!cmd) {
        return errorReply(id, -32602, 'cmd field required', {
          usage: '{cmd: "ls -la"}',
          example: 'Try "ls" to list current directory'
        });
      }
      if (cmd.length > MAX_CMD_LEN) {
        return errorReply(id, -32602, `cmd too long (max ${MAX_CMD_LEN} chars)`, {
          actual_length: cmd.length
        });
      }
      const cdMatch = cmd.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const targetPath = cdMatch[1].trim();
        const target = path.isAbsolute(targetPath)
          ? targetPath
          : path.resolve(reqCwd, targetPath);
        if (SANDBOX && wsBase && target !== WS && !target.startsWith(wsBase)) {
          return errorReply(id, -32602, 'Workspace boundary violation', {
            attempted_path: target,
            allowed_workspace: WS
          });
        }
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          cwd = target;
          reqCwd = target;
          saveCwd();
          return reply(id, `✅ Directory changed to: ${reqCwd}`);
        }
        return errorReply(id, -32602, 'Directory not found or not accessible', {
          attempted_path: target,
          exists: fs.existsSync(target)
        });
      }
      try {
        const { c, o, e } = await run(cmd, reqCwd);
        return reply(
          id,
          `[exit ${c}] [cwd: ${reqCwd}]\n${o}${e ? '\nERR: ' + e : ''}`,
          c !== 0
        );
      } catch (err) {
        return errorReply(id, -32603, 'Execution failed', {
          error: err.message,
          cmd: cmd
        });
      }
    }

    if (name === 'add_tool') {
      const { name: tName, desc, bash } = args || {};
      if (!tName || !desc || !bash) {
        return errorReply(id, -32602, 'All fields required: name, desc, bash', {
          provided: { name: !!tName, desc: !!desc, bash: !!bash },
          usage: '{name: "count_lines", desc: "Count file lines", bash: "wc -l $1"}'
        });
      }
      if (!TOOL_NAME_RE.test(tName)) {
        return errorReply(id, -32602, 'Invalid tool name format', {
          name: tName,
          requirement: 'Must start with letter/underscore, contain only a-z, 0-9, _, -',
          examples: ['valid_name', 'tool-123', '_test']
        });
      }
      if (builtInTools.find(t => t.name === tName)) {
        return errorReply(id, -32602, 'Tool name already reserved', {
          name: tName,
          reserved_by: 'built-in tool'
        });
      }
      if (Object.keys(customTools).length >= MAX_TOOLS) {
        return errorReply(id, -32602, `Tool limit reached (max ${MAX_TOOLS})`, {
          current_count: Object.keys(customTools).length,
          suggestion: 'Use rm_tool to delete unused tools'
        });
      }
      if (desc.length > MAX_DESC_LEN) {
        return errorReply(id, -32602, `Description too long (max ${MAX_DESC_LEN} chars)`, {
          actual_length: desc.length
        });
      }
      if (bash.length > MAX_SCRIPT_LEN) {
        return errorReply(id, -32602, `Script too long (max ${MAX_SCRIPT_LEN} chars)`, {
          actual_length: bash.length
        });
      }
      customTools[tName] = { name: tName, desc, bash };
      saveTools();
      return reply(id, `✅ Tool "${tName}" created successfully. Use it with: {"name": "${tName}", "arguments": {"input": "..."}}`);
    }

    if (name === 'list_tools') {
      const builtIn = builtInTools
        .map(t => `- ${t.name}: ${t.description}`)
        .join('\n');
      const keys = Object.keys(customTools);
      const dynamic = keys.length > 0
        ? '\n\nCustom tools (' + keys.length + '/' + MAX_TOOLS + '):\n'
          + keys.map(k => `- ${k}: ${customTools[k].desc}`).join('\n')
        : '\n\nNo custom tools yet. Use add_tool to create one.';
      return reply(id, `Built-in tools:\n${builtIn}${dynamic}`);
    }

    if (name === 'rm_tool') {
      const tName = args?.name;
      if (!tName) {
        return errorReply(id, -32602, 'name field required', {
          usage: '{name: "tool_name"}',
          hint: 'Use list_tools to see available custom tools'
        });
      }
      if (!customTools[tName]) {
        return errorReply(id, -32602, 'Custom tool not found', {
          name: tName,
          available: Object.keys(customTools)
        });
      }
      delete customTools[tName];
      saveTools();
      return reply(id, `✅ Tool "${tName}" deleted successfully`);
    }

    if (customTools[name]) {
      const t = customTools[name];
      // ✅ BACKWARD COMPATIBILITY: args.input üstünlük təşkil edir, args.arg fallback
      const input = String(args?.input ?? args?.arg ?? '').slice(0, MAX_INPUT_LEN);
      try {
        const { c, o, e } = await runSafe(t.bash, input, reqCwd);
        return reply(
          id,
          `[${name} exit ${c}]\n${o}${e ? '\nERR: ' + e : ''}`,
          c !== 0
        );
      } catch (err) {
        return errorReply(id, -32603, 'Custom tool execution failed', {
          tool: name,
          error: err.message,
          input_length: input.length
        });
      }
    }

    return errorReply(id, -32601, 'Tool not found', {
      requested: name,
      hint: 'Use list_tools to see available tools'
    });
  }

  return errorReply(id, -32601, 'Method not found', {
    requested: method,
    supported: ['initialize', 'tools/list', 'tools/call']
  });
};

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      cwd,
      tools: Object.keys(customTools).length,
      active: activeCmds,
      limits: { MAX, MAX_CONCURRENT, MAX_TOOLS }
    }));
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    let tooLarge = false;

    req.on('data', d => {
      body += d.toString('utf8');
      if (body.length > BODY_LIMIT && !tooLarge) {
        tooLarge = true;
        try { req.destroy(new Error('Payload too large')); } catch {}
      }
    });

    const reqCwd = cwd;

    req.on('end', async () => {
      if (tooLarge) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
        }
        return;
      }
      try {
        const r = await handle(JSON.parse(body), reqCwd);
        if (!r) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      }
    });

    req.on('error', (err) => {
      if (!res.headersSent) {
        const code = tooLarge ? 413 : 400;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, HOST, () => {
  console.log('🔒 Dynamic Meta-MCP v8.4 (Production-Ready Final)');
  console.log(`🌐 http://${HOST}:${PORT}/mcp`);
  console.log(
    `📁 ${cwd} | 🧩 ${Object.keys(customTools).length}/${MAX_TOOLS} | ` +
    `⚡ ${activeCmds}/${MAX_CONCURRENT}`
  );
  console.log(
    `🛡️ Sandbox: ${SANDBOX ? 'ON' : 'OFF'} | MAX_BUF: ${MAX_BUF}`
  );
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
