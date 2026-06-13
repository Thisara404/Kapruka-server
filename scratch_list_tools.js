import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = 'https://mcp.kapruka.com/mcp';

async function main() {
  console.log('Connecting to Kapruka MCP...');
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client(
    { name: 'mcp-explorer', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('Connected! Listing tools...');
  const toolsResponse = await client.listTools();
  console.log('Tools count:', toolsResponse.tools.length);
  for (const tool of toolsResponse.tools) {
    console.log(`\n======================================`);
    console.log(`Tool Name: ${tool.name}`);
    console.log(`Description: ${tool.description}`);
    console.log(`Input Schema:\n`, JSON.stringify(tool.inputSchema, null, 2));
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
