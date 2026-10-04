// Real-time Event Broadcaster & SSE Manager
const clients = new Map(); // workspaceId -> Set(res)

export const broadcastWorkspaceEvent = (workspaceId, eventType, data = {}) => {
  const payload = JSON.stringify({ event: eventType, data, timestamp: new Date().toISOString() });
  const workspaceClients = clients.get(workspaceId);
  if (workspaceClients) {
    for (const client of workspaceClients) {
      try {
        client.write(`event: ${eventType}\ndata: ${payload}\n\n`);
      } catch (err) {
        workspaceClients.delete(client);
      }
    }
  }
};

export const registerSseClient = (workspaceId, res) => {
  if (!clients.has(workspaceId)) {
    clients.set(workspaceId, new Set());
  }
  clients.get(workspaceId).add(res);

  return () => {
    const wsClients = clients.get(workspaceId);
    if (wsClients) {
      wsClients.delete(res);
      if (wsClients.size === 0) clients.delete(workspaceId);
    }
  };
};
