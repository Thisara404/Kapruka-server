import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';

const MCP_URL = 'https://mcp.kapruka.com/mcp';

async function main() {
  console.log('Connecting to Kapruka MCP...');
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client(
    { name: 'mcp-explorer', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log('Connected! Listing tools...');
  const toolsResponse = await client.listTools();
  console.log('Tools count:', toolsResponse.tools.length);

  let output = `Tools count: ${toolsResponse.tools.length}\n`;
  for (const tool of toolsResponse.tools) {
    output += `\n======================================\n`;
    output += `Tool Name: ${tool.name}\n`;
    output += `Description: ${tool.description}\n`;
    output += `Input Schema:\n${JSON.stringify(tool.inputSchema, null, 2)}\n`;
  }

  const dest = path.join(__dirname, 'mcp_tools.txt');
  fs.writeFileSync(dest, output, 'utf8');
  console.log(`Saved tool definitions to: ${dest}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
