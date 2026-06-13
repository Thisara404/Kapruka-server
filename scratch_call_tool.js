import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = 'https://mcp.kapruka.com/mcp';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client(
    { name: 'mcp-test', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  
  const result = await client.callTool({
    name: 'kapruka_search_products',
    arguments: {
      params: {
        q: 'cake',
        response_format: 'json'
      }
    }
  });

  console.log('--- CONTENT ---');
  if (result.content && Array.isArray(result.content)) {
    result.content.forEach((item, index) => {
      console.log(`[${index}] type: ${item.type}`);
      if (item.text) {
        console.log(`[${index}] text snippet: ${item.text.substring(0, 200)}...`);
        try {
          JSON.parse(item.text);
          console.log(`[${index}] text IS parseable as JSON`);
        } catch {
          console.log(`[${index}] text is NOT parseable as JSON`);
        }
      }
    });
  } else {
    console.log('No result.content or not an array');
  }

  console.log('--- STRUCTURED CONTENT ---');
  if (result.structuredContent) {
    console.log('structuredContent keys:', Object.keys(result.structuredContent));
    if (result.structuredContent.result) {
      console.log('result snippet:', result.structuredContent.result.substring(0, 200) + '...');
      try {
        JSON.parse(result.structuredContent.result);
        console.log('result IS parseable as JSON');
      } catch {
        console.log('result is NOT parseable as JSON');
      }
    }
  } else {
    console.log('No structuredContent');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
