/**
 * gc_mcp tool module — the 65 registrations and their tool-local helpers.
 *
 * The entry cache-busts and re-imports this module on a running server, so it
 * has no local imports (static or dynamic) and no top-level side effects.
 * Everything process-wide arrives through registerTools(server, shared).
 */
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
/** Everything the reloadable tool code borrows from the never-reloaded entry. */
export interface Shared {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
    gcBase: string;
    callStore: {
        getStore(): {
            conn: {
                id: string;
            };
            inlineSeqs: number[];
            afterReply: Array<(replied: boolean) => void>;
        } | undefined;
    };
    turnKeys: {
        turnKeyFor(slot: string, now?: number): string;
        finishTurnKey(slot: string, key: string, settled: boolean, now?: number): void;
        turnKeyKept(slot: string): string | undefined;
        isClientCutShort(e: unknown): boolean;
    };
    noteInlineSeq(json: any): void;
    describeError(e: any): string;
    packageDir: string;
}
export declare function registerTools(server: McpServer, shared: Shared): RegisteredTool[];
