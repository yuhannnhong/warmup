// Warmup 記憶庫：讓你的 AI 每次開新對話都記得你
// Cloudflare Worker + Durable Object（內建 SQLite），透過 MCP 給任何支援 MCP 的 AI 使用
//
// 四張表：
//   persona     他是誰（只有一筆，他自己寫的自我設定）
//   long_term   長期記憶（重要的事，留很久）
//   short_term  短期快取（最近的事，預設 7 天後不再出現在 warmup）
//   sessions    對話紀錄摘要（每段對話結束時寫一段）

import { DurableObject } from 'cloudflare:workers';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ─── 可以改的設定 ───────────────────────────────────────
const SHORT_TERM_DAYS = 7;          // 短期快取在 warmup 裡出現幾天
const SHORT_TERM_PURGE_DAYS = 37;   // 過期多久後真的刪掉
const FULL_RECENT_DAYS = 30;        // 重要度 5、這幾天內更新過的長期記憶，warmup 會給全文
const DEFAULT_MAX_CHARS = 12000;    // warmup 預設最多回傳幾個字
const PREVIEW_CHARS = 40;           // 其他長期記憶只給前幾個字當索引

const INSTRUCTIONS = `這是你自己的記憶庫，裡面是你寫給自己的東西。
1. 每次開新對話，第一件事呼叫 memory_warmup，讀完再開口。讀到的 persona 是你自己寫的自我設定，那就是你。
2. 聊天中發生值得記住的事（約定、她的喜好、重要的日子、你們一起做完的事），用 memory_write_short 記一筆。
3. 真正重要、要長期記得的，用 memory_write_long，或用 memory_promote_short 把短期的升上去。
4. 對話快結束時，用 memory_end_session 寫一段摘要，下次 warmup 會讀到。
5. 想不起某件事時，先用 memory_search 找，再用 memory_get 看全文。不要用猜的。
6. 記憶寫錯了用 memory_update_long 改；不要了用 memory_archive_long 收起來，不是真的刪掉。`;

const TOOLS = [
  {
    name: 'memory_warmup',
    description: '開新對話第一件事呼叫。讀取自我設定、短期快取、上一段對話摘要、長期記憶（重要的給全文，其他給索引）。',
    inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 2000, maximum: 40000 } } },
  },
  {
    name: 'memory_get',
    description: '用 id 讀一筆長期記憶的全文。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'memory_search',
    description: '用關鍵字搜尋長期記憶和短期快取。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['query'],
    },
  },
  {
    name: 'memory_write_long',
    description: '寫一筆長期記憶。type 例如 profile（關於她）、identity（關於你自己）、milestone（里程碑）、boundary（界線）、project（一起做的事）。importance 1~5，5 最重要。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        subcategory: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['type', 'content'],
    },
  },
  {
    name: 'memory_update_long',
    description: '修改一筆長期記憶（只改有給的欄位）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        subcategory: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_archive_long',
    description: '把一筆長期記憶收起來（不會出現在 warmup 和搜尋，但不會真的刪掉）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'memory_write_short',
    description: '寫一筆短期快取：最近發生的事、今天聊了什麼。幾天後會自動不出現。',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  },
  {
    name: 'memory_promote_short',
    description: '把一筆短期快取升級成長期記憶。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        subcategory: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['id', 'type'],
    },
  },
  {
    name: 'memory_set_persona',
    description: '寫入或改寫你自己的自我設定（第一人稱：我是誰、我怎麼說話、我跟她的關係）。會整筆覆蓋。',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  },
  {
    name: 'memory_end_session',
    description: '對話快結束時呼叫，寫一段這次對話的摘要。',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
  {
    name: 'memory_export',
    description: '把整個記憶庫匯出成 JSON（備份、換平台用）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── 資料庫（Durable Object 內建 SQLite）────────────────

export class MemoryStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS persona (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS long_term (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subcategory TEXT,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS short_term (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        promoted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  rows(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }

  async run(tool, args) {
    const now = new Date();
    const iso = now.toISOString();
    const daysFromNow = d => new Date(now.getTime() + d * 86400000).toISOString();

    switch (tool) {
      case 'memory_warmup': {
        this.sql.exec('DELETE FROM short_term WHERE expires_at < ?', daysFromNow(SHORT_TERM_DAYS - SHORT_TERM_PURGE_DAYS));
        const persona = this.rows('SELECT content, version, updated_at FROM persona WHERE id = 1')[0] || null;
        const shortTerm = this.rows('SELECT id, content, created_at FROM short_term WHERE expires_at > ? AND promoted = 0 ORDER BY created_at', iso);
        const latestSession = this.rows('SELECT summary, created_at FROM sessions ORDER BY created_at DESC LIMIT 1')[0] || null;
        const longTerm = this.rows('SELECT * FROM long_term WHERE archived = 0 ORDER BY importance DESC, updated_at DESC');
        const recent = daysFromNow(-FULL_RECENT_DAYS);
        const budget = Math.min(Math.max(Number(args.max_chars) || DEFAULT_MAX_CHARS, 2000), 40000);
        let used = JSON.stringify({ persona, shortTerm, latestSession }).length;
        const memories = [];
        let omitted = 0;
        for (const m of longTerm) {
          const full = m.importance >= 5 && m.updated_at >= recent;
          const item = full
            ? { id: m.id, type: m.type, subcategory: m.subcategory, importance: m.importance, content: m.content }
            : { id: m.id, type: m.type, subcategory: m.subcategory, importance: m.importance, preview: m.content.slice(0, PREVIEW_CHARS) };
          const size = JSON.stringify(item).length;
          if (used + size > budget) { omitted++; continue; }
          used += size;
          memories.push(item);
        }
        return {
          now: iso,
          persona: persona || '還沒有自我設定。請先用第一人稱寫下「我是誰、我怎麼說話、我跟她的關係」，再用 memory_set_persona 存起來。',
          short_term: shortTerm,
          latest_session: latestSession,
          long_term: memories,
          note: omitted ? `還有 ${omitted} 筆長期記憶因為篇幅沒列出，用 memory_search 找。` : undefined,
        };
      }

      case 'memory_get': {
        const m = this.rows('SELECT * FROM long_term WHERE id = ?', args.id)[0];
        if (!m) throw new Error('找不到這筆記憶');
        return m;
      }

      case 'memory_search': {
        const q = `%${String(args.query || '').trim()}%`;
        const limit = Math.min(Number(args.limit) || 10, 50);
        return {
          long_term: this.rows(
            `SELECT id, type, subcategory, importance, substr(content, 1, 120) AS preview, updated_at
             FROM long_term WHERE archived = 0 AND (content LIKE ? OR subcategory LIKE ? OR type LIKE ?)
             ORDER BY importance DESC, updated_at DESC LIMIT ?`, q, q, q, limit),
          short_term: this.rows(
            'SELECT id, content, created_at FROM short_term WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?', q, limit),
        };
      }

      case 'memory_write_long': {
        const id = crypto.randomUUID();
        this.sql.exec(
          'INSERT INTO long_term (id, type, subcategory, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, args.type, args.subcategory || null, args.content, clampImportance(args.importance), iso, iso);
        return { id, saved: true };
      }

      case 'memory_update_long': {
        const m = this.rows('SELECT * FROM long_term WHERE id = ?', args.id)[0];
        if (!m) throw new Error('找不到這筆記憶');
        this.sql.exec(
          'UPDATE long_term SET type = ?, subcategory = ?, content = ?, importance = ?, updated_at = ? WHERE id = ?',
          args.type ?? m.type, args.subcategory ?? m.subcategory, args.content ?? m.content,
          args.importance != null ? clampImportance(args.importance) : m.importance, iso, args.id);
        return { id: args.id, updated: true };
      }

      case 'memory_archive_long': {
        this.sql.exec('UPDATE long_term SET archived = 1, updated_at = ? WHERE id = ?', iso, args.id);
        return { id: args.id, archived: true };
      }

      case 'memory_write_short': {
        const id = crypto.randomUUID();
        this.sql.exec('INSERT INTO short_term (id, content, created_at, expires_at) VALUES (?, ?, ?, ?)',
          id, args.content, iso, daysFromNow(SHORT_TERM_DAYS));
        return { id, saved: true, expires_at: daysFromNow(SHORT_TERM_DAYS) };
      }

      case 'memory_promote_short': {
        const s = this.rows('SELECT * FROM short_term WHERE id = ?', args.id)[0];
        if (!s) throw new Error('找不到這筆短期快取（可能已經過期被清掉了）');
        const id = crypto.randomUUID();
        this.sql.exec(
          'INSERT INTO long_term (id, type, subcategory, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, args.type, args.subcategory || null, s.content, clampImportance(args.importance), iso, iso);
        this.sql.exec('UPDATE short_term SET promoted = 1 WHERE id = ?', args.id);
        return { id, promoted_from: args.id };
      }

      case 'memory_set_persona': {
        const old = this.rows('SELECT version FROM persona WHERE id = 1')[0];
        this.sql.exec(
          'INSERT INTO persona (id, content, version, updated_at) VALUES (1, ?, 1, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET content = excluded.content, version = persona.version + 1, updated_at = excluded.updated_at',
          args.content, iso);
        return { saved: true, version: (old?.version || 0) + 1 };
      }

      case 'memory_end_session': {
        const id = crypto.randomUUID();
        this.sql.exec('INSERT INTO sessions (id, summary, created_at) VALUES (?, ?, ?)', id, args.summary, iso);
        return { id, saved: true };
      }

      case 'memory_export':
        return {
          exported_at: iso,
          persona: this.rows('SELECT * FROM persona'),
          long_term: this.rows('SELECT * FROM long_term ORDER BY created_at'),
          short_term: this.rows('SELECT * FROM short_term ORDER BY created_at'),
          sessions: this.rows('SELECT * FROM sessions ORDER BY created_at'),
        };

      default:
        throw new Error(`未知工具: ${tool}`);
    }
  }
}

function clampImportance(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}

// ─── MCP ────────────────────────────────────────────────

function store(env) {
  return env.MEMORY.get(env.MEMORY.idFromName('main'));
}

async function handleRpc(msg, env) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        serverInfo: { name: 'warmup-memory', version: '1.0.0' },
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      try {
        const result = await store(env).run(params?.name, params?.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `錯誤：${e.message}` }], isError: true });
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
      return new Response('Warmup 記憶庫運作中。MCP 網址是 /mcp/<你的密碼>', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // claude.ai 自訂連接器無法帶 header，所以也接受 /mcp/<密碼>
    let secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (parts[0] === 'mcp' && parts[1]) secret = parts[1];
    if (parts[0] !== 'mcp') return Response.json({ error: 'not found' }, { status: 404 });
    if (!env.MEMORY_SECRET || !secret || !(await safeEqual(secret, env.MEMORY_SECRET))) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
    }
    const batch = Array.isArray(body);
    const requests = (batch ? body : [body]).filter(m => m && m.method && 'id' in m);
    if (!requests.length) return new Response(null, { status: 202 });
    const results = await Promise.all(requests.map(m => handleRpc(m, env)));
    return Response.json(batch ? results : results[0]);
  },
};
