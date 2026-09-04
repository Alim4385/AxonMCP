# AxonMCP 🧠
> LLM-powered dynamic tool server for Termux & tiny models (0.5B+)
> Made in Azerbaijan 🇦🇿

## What is it?
A self-expanding MCP server — the LLM creates its own tools at runtime,
saves them, and reuses them across sessions.

## Quick Start
```bash
node Server.js
```
Server runs at `http://127.0.0.1:3000/mcp`

## Built-in Tools

| Tool | Description |
|------|-------------|
| `run` | Execute shell commands, navigate directories |
| `add_tool` | Create a custom bash tool (persisted) |
| `list_tools` | List all available tools |
| `rm_tool` | Delete a custom tool |

## Custom Tool Example
```json
{
  "name": "add_tool",
  "arguments": {
    "name": "count_lines",
    "desc": "Count lines in a file",
    "bash": "wc -l $1"
  }
}
```

## Health Check
```bash
curl http://127.0.0.1:3000/health
```

## Configuration
Edit constants at the top of `axon.js`:
| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_TOOLS` | 50 | Max custom tools |
| `MAX_CONCURRENT` | 5 | Parallel processes |
| `SANDBOX` | false | Restrict to workspace |
| `TM` | 60000 | Command timeout (ms) |

## Security
- Bash injection protected via spawn array
- Memory-safe streaming output
- Prototype pollution prevention
- DoS protection (payload + concurrency limits)

## Requirements
- Node.js 16+
- Termux (Android) or any Linux
