import { ApprovalRegistry } from "./approval.js";
import { AuditLog } from "./audit.js";
import { SqliteMemoryStore } from "./memory.js";
import { PageSnapshotStore } from "./pageSnapshotStore.js";
import { createAgentServer } from "./server.js";
import { openSqliteDatabase } from "./sqlite.js";
import { ProviderConfigStore } from "./providerStore.js";
import { TaskStore } from "./taskStore.js";

const port = Number(process.env.OAB_AGENT_PORT ?? 17376);
const database = await openSqliteDatabase(process.env.OAB_SQLITE_PATH);
const memory = new SqliteMemoryStore(database);
const server = createAgentServer({
  context: {
    approvals: new ApprovalRegistry(),
    auditLog: new AuditLog(database),
    memory,
    pageSnapshots: new PageSnapshotStore(database),
    providerConfigStore: new ProviderConfigStore(database),
    taskStore: new TaskStore(database)
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`open-agent-browser agent server listening on http://127.0.0.1:${port}`);
});

process.on("SIGINT", () => {
  server.close();
  database.close();
});
