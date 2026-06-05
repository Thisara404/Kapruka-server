import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = "https://mcp.kapruka.com/mcp";

let client: Client | null = null;
let isConnecting = false;

export async function getMcpClient(): Promise<Client> {
  if (client) {
    return client;
  }

  if (isConnecting) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (client) return client;
    throw new Error("MCP connection in progress, please retry");
  }

  isConnecting = true;

  try {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const newClient = new Client(
      { name: "thisari-agent", version: "1.0.0" },
      { capabilities: {} }
    );

    await newClient.connect(transport);
    client = newClient;
    console.log("[MCP] Connected to Kapruka MCP server");
    return client;
  } catch (error) {
    console.error("[MCP] Connection failed:", error);
    throw new Error(
      `Failed to connect to Kapruka MCP: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  } finally {
    isConnecting = false;
  }
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  const c = await getMcpClient();

  try {
    const result = await c.callTool({ name: toolName, arguments: args });

    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find(
        (c: { type: string }) => c.type === "text"
      );
      if (textContent && "text" in textContent) {
        // Parse as JSON if possible, otherwise return raw text
        const text = textContent.text as string;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }

    if (result.structuredContent) {
      return result.structuredContent;
    }

    return result;
  } catch (error) {
    client = null;
    console.error(`[MCP] Tool call failed (${toolName}):`, error);
    throw error;
  }
}

export function resetMcpClient() {
  client = null;
  isConnecting = false;
}
