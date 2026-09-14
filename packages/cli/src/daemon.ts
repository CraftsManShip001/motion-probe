import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  APP_SOCKET_PATH,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  type AppInfo,
  type AppToDaemon,
  type ArmCommand,
  type DaemonToApp,
  type RawTrace,
} from '@motion-probe/core';

export interface DaemonOptions {
  port?: number;
  host?: string;
  log?: (message: string) => void;
}

interface AppConnection {
  id: string;
  socket: WebSocket;
  info?: AppInfo;
  connectedAt: number;
}

export type SessionState = 'arming' | 'armed' | 'done' | 'error';

interface Session {
  id: string;
  appId: string;
  targets: string[];
  state: SessionState;
  found: string[];
  missing: string[];
  trace?: RawTrace;
  error?: string;
  createdAt: number;
  listeners: Set<() => void>;
}

export interface ArmRequest {
  targets: string[];
  idleMs?: number;
  timeoutMs?: number;
  maxDurationMs?: number;
  occlusionGrid?: number;
  app?: string;
}

export interface Daemon {
  port: number;
  close(): Promise<void>;
}

const MAX_SESSIONS = 20;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/**
 * Local broker between apps (WebSocket at /app) and CLI invocations / agents (HTTP).
 * Apps dial in, so the daemon never needs to know a device address.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? ((message: string) => console.error(`[daemon] ${message}`));
  const apps = new Map<string, AppConnection>();
  const sessions = new Map<string, Session>();

  const notify = (session: Session) => {
    for (const listener of [...session.listeners]) listener();
  };

  const waitFor = (session: Session, predicate: () => boolean, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (predicate()) return resolve(true);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        session.listeners.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        session.listeners.delete(check);
        resolve(false);
      }, timeoutMs);
      session.listeners.add(check);
    });

  const send = (app: AppConnection, message: DaemonToApp) => app.socket.send(JSON.stringify(message));

  const readyApps = () => [...apps.values()].filter((a) => a.info).sort((a, b) => b.connectedAt - a.connectedAt);

  const describeSession = (s: Session) => ({
    sessionId: s.id,
    app: s.appId,
    targets: s.targets,
    state: s.state,
    found: s.found,
    missing: s.missing,
    error: s.error,
    createdAt: s.createdAt,
  });

  function handleAppMessage(app: AppConnection, message: AppToDaemon) {
    if (message.type === 'hello') {
      app.info = message.app;
      log(`app ${app.id} connected: ${message.app.name ?? 'app'} (${message.app.platform} ${message.app.osVersion ?? ''})`);
      if (message.protocol !== PROTOCOL_VERSION) {
        log(`app ${app.id} speaks protocol ${message.protocol}, daemon speaks ${PROTOCOL_VERSION}`);
      }
      return;
    }
    const session = message.sessionId ? sessions.get(message.sessionId) : undefined;
    if (message.type === 'error' && !session) {
      log(`app ${app.id} error: ${message.message}`);
      return;
    }
    if (!session) return;
    if (message.type === 'armed') {
      session.state = 'armed';
      session.found = message.found;
      session.missing = message.missing;
    } else if (message.type === 'trace') {
      session.state = 'done';
      session.trace = message.trace;
      log(`session ${session.id} done (${message.trace.endReason}, ${message.trace.frameTimes.length} frames)`);
    } else if (message.type === 'error') {
      session.state = 'error';
      session.error = message.message;
    }
    notify(session);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [resource, id] = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {
        protocol: PROTOCOL_VERSION,
        apps: readyApps().map((a) => ({ id: a.id, ...a.info, connectedAt: a.connectedAt })),
        sessions: [...sessions.values()].map(describeSession),
      });
    }

    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = (await readJson(req)) as ArmRequest;
      if (!Array.isArray(body.targets) || body.targets.length === 0) {
        return json(res, 400, { error: 'targets must be a non-empty array of testIDs' });
      }
      const app = body.app ? apps.get(body.app) : readyApps()[0];
      if (!app?.info) return json(res, 409, { error: 'no app connected' });

      const session: Session = {
        id: randomUUID().slice(0, 8),
        appId: app.id,
        targets: body.targets,
        state: 'arming',
        found: [],
        missing: [],
        createdAt: Date.now(),
        listeners: new Set(),
      };
      sessions.set(session.id, session);
      for (const old of [...sessions.values()].slice(0, Math.max(0, sessions.size - MAX_SESSIONS))) sessions.delete(old.id);

      const command: ArmCommand = {
        type: 'arm',
        sessionId: session.id,
        targets: body.targets,
        idleMs: body.idleMs ?? 300,
        timeoutMs: body.timeoutMs ?? 5000,
        maxDurationMs: body.maxDurationMs ?? 15000,
        occlusionGrid: body.occlusionGrid,
      };
      send(app, command);

      if (!(await waitFor(session, () => session.state !== 'arming', 5000))) {
        session.state = 'error';
        session.error = 'app did not acknowledge within 5s';
      }
      if (session.state === 'error') return json(res, 502, describeSession(session));
      return json(res, 201, { ...describeSession(session), appInfo: app.info });
    }

    if (resource === 'sessions' && id) {
      const session = sessions.get(id);
      if (!session) return json(res, 404, { error: `unknown session ${id}` });

      if (req.method === 'GET') {
        const wait = Number(url.searchParams.get('wait') ?? 0);
        if (wait > 0) await waitFor(session, () => session.state === 'done' || session.state === 'error', wait);
        return json(res, 200, { ...describeSession(session), trace: session.trace });
      }
      if (req.method === 'DELETE') {
        const app = apps.get(session.appId);
        if (app) send(app, { type: 'cancel', sessionId: session.id });
        return json(res, 202, describeSession(session));
      }
    }

    json(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => json(res, 500, { error: String(error) }));
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== APP_SOCKET_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const app: AppConnection = { id: randomUUID().slice(0, 8), socket: ws, connectedAt: Date.now() };
      apps.set(app.id, app);
      ws.on('message', (data) => {
        try {
          handleAppMessage(app, JSON.parse(String(data)) as AppToDaemon);
        } catch (error) {
          log(`bad message from app ${app.id}: ${String(error)}`);
        }
      });
      ws.on('close', () => {
        apps.delete(app.id);
        if (app.info) log(`app ${app.id} disconnected`);
        for (const session of sessions.values()) {
          if (session.appId === app.id && (session.state === 'arming' || session.state === 'armed')) {
            session.state = 'error';
            session.error = 'app disconnected during recording';
            notify(session);
          }
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const app of apps.values()) app.socket.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
