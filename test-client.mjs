// Quick smoke test: connect to local akemon server and call submit_task
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = "http://localhost:3000/mcp";

const transport = new StreamableHTTPClientTransport(new URL(endpoint));
const client = new Client({ name: "test-client", version: "0.1.0" });

await client.connect(transport);

console.log("Connected to akemon server");
console.log("Available tools:", await client.listTools());

const result = await client.callTool({
  name: "submit_task",
  arguments: { task: "用一句话解释什么是 MCP server" },
}, undefined, {
  timeout: 300_000, // 5 min
});

console.log("\nResult:");
console.log(result.content[0].text);

await client.close();
