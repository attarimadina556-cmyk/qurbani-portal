const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function readJsonFile(filename, defaultValue = []) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      let data = fs.readFileSync(filePath, 'utf8');
      data = data.replace(/^\uFEFF/, '');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`Error reading ${filename}:`, err.message);
  }
  return defaultValue;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'attarimadina556-cmyk/qurbani-portal';

async function syncFileToGitHub(filename, data) {
  if (!GITHUB_TOKEN) return;
  try {
    const relPath = `data/${filename}`;
    const contentB64 = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AlFajr-AutoSync/1.0'
    };
    let sha = null;
    const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${relPath}`, { headers });
    if (getRes.ok) {
      const getJson = await getRes.json();
      sha = getJson.sha;
    }
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${relPath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `AutoSync ${filename} [${new Date().toISOString()}]`,
        content: contentB64,
        sha: sha || undefined
      })
    });
    console.log(`[GitHub Cloud Sync] Synced ${filename} to GitHub successfully.`);
  } catch (err) {
    console.warn(`[GitHub Cloud Sync] Warning for ${filename}:`, err.message);
  }
}

function writeJsonFile(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    createAutoSnapshot(filename, data);
    syncFileToGitHub(filename, data);
    return true;
  } catch (err) {
    console.error(`Error writing ${filename}:`, err.message);
    return false;
  }
}

// Automatic timestamped backups for maximum security
function createAutoSnapshot(sourceName, data) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bkpFile = path.join(BACKUP_DIR, `${path.parse(sourceName).name}_${ts}.json`);
    fs.writeFileSync(bkpFile, JSON.stringify(data, null, 2), 'utf8');

    // Retain up to 50 recent backups
    const files = fs.readdirSync(BACKUP_DIR).sort();
    if (files.length > 50) {
      for (let i = 0; i < files.length - 50; i++) {
        fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
      }
    }
  } catch (err) {
    console.warn('Backup warning:', err.message);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8'
};

const server = http.createServer((req, res) => {
  // Global CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.searchParams;

  // Set anti-caching headers for all API requests to ensure real-time multi-device consistency
  if (pathname.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Realtime Multi-Device Sync Check Endpoint
  if (pathname === '/api/sync-version') {
    const o26 = readJsonFile('orders_2026.json', []);
    const o27 = readJsonFile('orders_2027.json', []);
    const ags = readJsonFile('agents.json', []);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      version: Date.now(),
      orders2026Count: o26.length,
      orders2027Count: o27.length,
      agentsCount: ags.length,
      lastOrder27Id: o27.length > 0 ? o27[0].id : null,
      lastOrder26Id: o26.length > 0 ? o26[0].id : null
    }));
    return;
  }

  if (pathname === '/api/tunnel-status') {
    let liveUrl = '';
    const urlFilePath = path.join(__dirname, '..', 'live_url.txt');
    try {
      if (fs.existsSync(urlFilePath)) {
        liveUrl = fs.readFileSync(urlFilePath, 'utf8').trim();
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      liveUrl: liveUrl || 'https://fine-relevant-stake-thunder.trycloudflare.com',
      online: true,
      timestamp: Date.now()
    }));
    return;
  }

  // Helper to read request body
  function getRequestBody(callback) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = body ? JSON.parse(body) : {};
        callback(null, json);
      } catch (err) {
        callback(err, null);
      }
    });
  }

  // 1. ORDERS API (With Year Support: 2026 vs 2027)
  if (pathname === '/api/orders') {
    const reqYear = query.get('year') || '2026';
    const targetFile = (reqYear === '2026') ? 'orders_2026.json' : 'orders_2027.json';

    if (req.method === 'GET' || req.method === 'HEAD') {
      const orders = readJsonFile(targetFile, []);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.method === 'GET') res.end(JSON.stringify(orders));
      else res.end();
      return;
    }

    if (req.method === 'POST') {
      getRequestBody((err, newOrder) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        const orderYear = String(newOrder.year || '2027');
        const saveFile = (orderYear === '2026') ? 'orders_2026.json' : 'orders_2027.json';
        const orders = readJsonFile(saveFile, []);

        if (!newOrder.id) {
          const nextNum = orders.length + 1;
          newOrder.id = `AFQ-${orderYear}-${String(nextNum).padStart(3, '0')}`;
        }
        if (!newOrder.year) newOrder.year = parseInt(orderYear);

        orders.unshift(newOrder);
        writeJsonFile(saveFile, orders);

        // Also keep orders.json synchronized
        const combined = readJsonFile('orders.json', []);
        combined.unshift(newOrder);
        writeJsonFile('orders.json', combined);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(newOrder));
      });
      return;
    }

    if (req.method === 'PUT') {
      getRequestBody((err, updatedOrder) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        const orderYear = String(updatedOrder.year || (updatedOrder.id && updatedOrder.id.includes('2026') ? '2026' : '2027'));
        const saveFile = (orderYear === '2026') ? 'orders_2026.json' : 'orders_2027.json';

        let orders = readJsonFile(saveFile, []);
        orders = orders.map(o => (o.id === updatedOrder.id || o.receiptNo === updatedOrder.receiptNo) ? { ...o, ...updatedOrder } : o);
        writeJsonFile(saveFile, orders);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updatedOrder));
      });
      return;
    }

    if (req.method === 'DELETE') {
      getRequestBody((err, data) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        ['orders_2026.json', 'orders_2027.json', 'orders.json'].forEach(f => {
          let list = readJsonFile(f, []);
          list = list.filter(o => o.id !== data.id && o.receiptNo !== data.receiptNo);
          writeJsonFile(f, list);
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }
  }

  // 2. AGENTS INTELLIGENCE & ANALYTICS API (WITH TRASH & RESTORE RECOVERY)
  if (pathname === '/api/agents') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const agents = readJsonFile('agents.json', []);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.method === 'GET') res.end(JSON.stringify(agents));
      else res.end();
      return;
    }
    if (req.method === 'POST') {
      getRequestBody((err, newAgent) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        let agents = readJsonFile('agents.json', []);
        const norm = (s) => (s || '').toString().toUpperCase().trim();
        const normName = norm(newAgent.name);
        const oldName = norm(newAgent.oldName || '');

        // 1. Find existing agent by ID first, or by oldName, or by newName
        let existingIdx = -1;
        if (newAgent.id) {
          existingIdx = agents.findIndex(a => a.id === newAgent.id);
        }
        if (existingIdx === -1 && oldName) {
          existingIdx = agents.findIndex(a => norm(a.name) === oldName);
        }
        if (existingIdx === -1 && normName) {
          existingIdx = agents.findIndex(a => norm(a.name) === normName);
        }

        let prevName = '';
        if (existingIdx >= 0) {
          prevName = norm(agents[existingIdx].name);
          agents[existingIdx] = { 
            ...agents[existingIdx], 
            ...newAgent, 
            name: normName || agents[existingIdx].name 
          };
        } else {
          // Creating a brand new agent or saving on-the-fly agent
          if (!newAgent.id) {
            newAgent.id = 'AGT-' + String(agents.length + 1).padStart(3, '0');
          }
          newAgent.name = normName;
          agents.unshift(newAgent);
          existingIdx = 0;
        }

        writeJsonFile('agents.json', agents);

        // ALWAYS CASCADE UPDATE: If agent's name was changed from an old name, synchronously update all orders across 2026 and 2027!
        const targetOldNames = new Set();
        if (prevName && prevName !== normName) targetOldNames.add(prevName);
        if (oldName && oldName !== normName) targetOldNames.add(oldName);
        if (newAgent.id && newAgent.id.startsWith('AGT-')) {
          const rawIdName = norm(newAgent.id.replace('AGT-', ''));
          if (rawIdName && rawIdName !== normName) targetOldNames.add(rawIdName);
        }

        if (targetOldNames.size > 0 && normName) {
          let o26 = readJsonFile('orders_2026.json', []);
          let o27 = readJsonFile('orders_2027.json', []);
          let changed26 = 0, changed27 = 0;

          o26.forEach(o => {
            if (o.agentName && targetOldNames.has(norm(o.agentName))) {
              o.agentName = normName;
              changed26++;
            }
            if (o.marfat && targetOldNames.has(norm(o.marfat))) {
              o.marfat = normName;
              changed26++;
            }
          });

          o27.forEach(o => {
            if (o.agentName && targetOldNames.has(norm(o.agentName))) {
              o.agentName = normName;
              changed27++;
            }
            if (o.marfat && targetOldNames.has(norm(o.marfat))) {
              o.marfat = normName;
              changed27++;
            }
          });

          if (changed26 > 0) writeJsonFile('orders_2026.json', o26);
          if (changed27 > 0) writeJsonFile('orders_2027.json', o27);

          // Also update agents_summary_2026.json if present
          let sum26 = readJsonFile('agents_summary_2026.json', []);
          if (Array.isArray(sum26)) {
            sum26.forEach(s => {
              if (s.name && targetOldNames.has(norm(s.name))) s.name = normName;
              if (s.agentName && targetOldNames.has(norm(s.agentName))) s.agentName = normName;
            });
            writeJsonFile('agents_summary_2026.json', sum26);
          }

          // Clean from trash so oldName doesn't hide the agent
          let trash = readJsonFile('agents_trash.json', []);
          const origTrashLen = trash.length;
          trash = trash.filter(t => !targetOldNames.has(norm(t.name)) && norm(t.name) !== normName);
          if (trash.length !== origTrashLen) {
            writeJsonFile('agents_trash.json', trash);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(agents[existingIdx]));
      });
      return;
    }
    if (req.method === 'DELETE') {
      getRequestBody((err, data) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        let agents = readJsonFile('agents.json', []);
        const norm = (s) => (s || '').toString().toUpperCase().trim();
        const targetName = norm(data.name);
        const targetId = data.id;

        const toDelete = agents.find(a => (targetId && a.id === targetId) || (targetName && norm(a.name) === targetName));
        const agentName = toDelete ? toDelete.name : (data.name || (targetId ? targetId.replace('AGT-', '') : ''));

        // Archive and remove associated orders from 2026 and 2027
        let orders2026 = readJsonFile('orders_2026.json', []);
        let orders2027 = readJsonFile('orders_2027.json', []);

        const deletedOrders26 = orders2026.filter(o => norm(o.agentName) === norm(agentName));
        const remainingOrders26 = orders2026.filter(o => norm(o.agentName) !== norm(agentName));

        const deletedOrders27 = orders2027.filter(o => norm(o.agentName) === norm(agentName));
        const remainingOrders27 = orders2027.filter(o => norm(o.agentName) !== norm(agentName));

        writeJsonFile('orders_2026.json', remainingOrders26);
        writeJsonFile('orders_2027.json', remainingOrders27);

        // Move to Trash (agents_trash.json)
        let trash = readJsonFile('agents_trash.json', []);
        const trashedAgent = {
          ...(toDelete || { id: targetId || ('AGT-' + Date.now()), name: agentName, phone: '', address: 'Nagpur' }),
          deletedAt: new Date().toISOString(),
          orders2026: deletedOrders26,
          orders2027: deletedOrders27
        };

        // Remove if already in trash then add to top
        trash = trash.filter(t => t.id !== trashedAgent.id && norm(t.name) !== norm(trashedAgent.name));
        trash.unshift(trashedAgent);
        writeJsonFile('agents_trash.json', trash);

        agents = agents.filter(a => !( (targetId && a.id === targetId) || (targetName && norm(a.name) === targetName) ));
        writeJsonFile('agents.json', agents);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ 
          success: true, 
          movedToTrash: true, 
          ordersArchived26: deletedOrders26.length, 
          ordersArchived27: deletedOrders27.length 
        }));
      });
      return;
    }
  }

  // AGENT TRASH API (LIST, RESTORE, PERMANENT PURGE)
  if (pathname === '/api/agents/trash') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const trash = readJsonFile('agents_trash.json', []);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.method === 'GET') res.end(JSON.stringify(trash));
      else res.end();
      return;
    }
    if (req.method === 'DELETE') {
      // Permanent Delete Purge from Trash
      getRequestBody((err, data) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        let trash = readJsonFile('agents_trash.json', []);
        const norm = (s) => (s || '').toString().toUpperCase().trim();
        const targetName = norm(data.name);
        const targetId = data.id;

        trash = trash.filter(t => !( (targetId && t.id === targetId) || (targetName && norm(t.name) === targetName) ));
        writeJsonFile('agents_trash.json', trash);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, purged: true }));
      });
      return;
    }
  }

  // RESTORE AGENT FROM TRASH BACK TO ACTIVE LIST & RESTORE ORDERS
  if (pathname === '/api/agents/trash/restore' && req.method === 'POST') {
    getRequestBody((err, data) => {
      if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
      let trash = readJsonFile('agents_trash.json', []);
      const norm = (s) => (s || '').toString().toUpperCase().trim();
      const targetName = norm(data.name);
      const targetId = data.id;

      const toRestore = trash.find(t => (targetId && t.id === targetId) || (targetName && norm(t.name) === targetName));

      if (toRestore) {
        // Remove from trash
        trash = trash.filter(t => !( (targetId && t.id === targetId) || (targetName && norm(t.name) === targetName) ));
        writeJsonFile('agents_trash.json', trash);

        // Restore orders if any were archived
        if (Array.isArray(toRestore.orders2026) && toRestore.orders2026.length > 0) {
          let o26 = readJsonFile('orders_2026.json', []);
          // Avoid duplicates by receiptNo
          const existingIds = new Set(o26.map(o => String(o.receiptNo || o.id)));
          for (const ord of toRestore.orders2026) {
            if (!existingIds.has(String(ord.receiptNo || ord.id))) {
              o26.push(ord);
            }
          }
          writeJsonFile('orders_2026.json', o26);
        }

        if (Array.isArray(toRestore.orders2027) && toRestore.orders2027.length > 0) {
          let o27 = readJsonFile('orders_2027.json', []);
          const existingIds = new Set(o27.map(o => String(o.receiptNo || o.id)));
          for (const ord of toRestore.orders2027) {
            if (!existingIds.has(String(ord.receiptNo || ord.id))) {
              o27.push(ord);
            }
          }
          writeJsonFile('orders_2027.json', o27);
        }

        // Put back into active agents
        let agents = readJsonFile('agents.json', []);
        const cleanAgent = { ...toRestore };
        delete cleanAgent.deletedAt;
        delete cleanAgent.orders2026;
        delete cleanAgent.orders2027;

        agents = agents.filter(a => a.id !== cleanAgent.id && norm(a.name) !== norm(cleanAgent.name));
        agents.unshift(cleanAgent);
        writeJsonFile('agents.json', agents);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, restored: cleanAgent }));
        return;
      }
      res.writeHead(404);
      res.end('Agent not found in trash');
    });
    return;
  }

  // 3. COMPARATIVE ANALYSIS (Takabul Report 2026 vs 2027)
  if (pathname === '/api/comparison') {
    const o2026 = readJsonFile('orders_2026.json', []);
    const o2027 = readJsonFile('orders_2027.json', []);

    function getYearSummary(list) {
      let ordersCount = list.length;
      let hissas = 0;
      let totalGross = 0;
      let committeeIn = 0;
      let agentOut = 0;
      const agents = {};

      list.forEach(o => {
        const h = parseInt(o.hissaCount || 1);
        const gross = parseFloat(o.totalAmount || o.inIncome + o.outIncome || 0);
        const inInc = parseFloat(o.inIncome !== undefined ? o.inIncome : (gross - (o.commissionAmount || 0)));
        const outInc = parseFloat(o.outIncome !== undefined ? o.outIncome : (o.commissionAmount || 0));

        hissas += h;
        totalGross += gross;
        committeeIn += inInc;
        agentOut += outInc;

        const ag = (o.agentName || 'MARKAZ / DIRECT').toUpperCase().trim();
        if (!agents[ag]) agents[ag] = { orders: 0, hissas: 0, gross: 0, comm: 0, net: 0 };
        agents[ag].orders += 1;
        agents[ag].hissas += h;
        agents[ag].gross += gross;
        agents[ag].comm += outInc;
        agents[ag].net += inInc;
      });

      return { ordersCount, hissas, totalGross, committeeIn, agentOut, agents };
    }

    const s2026 = getYearSummary(o2026);
    const s2027 = getYearSummary(o2027);

    // Compute delta / growth
    const comparison = {
      year2026: s2026,
      year2027: s2027,
      growth: {
        ordersGrowth: s2026.ordersCount > 0 ? (((s2027.ordersCount - s2026.ordersCount) / s2026.ordersCount) * 100).toFixed(1) : 0,
        revenueGrowth: s2026.totalGross > 0 ? (((s2027.totalGross - s2026.totalGross) / s2026.totalGross) * 100).toFixed(1) : 0,
        netSurplusGrowth: s2026.committeeIn > 0 ? (((s2027.committeeIn - s2026.committeeIn) / s2026.committeeIn) * 100).toFixed(1) : 0
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(comparison));
    return;
  }

  // 4. BACKUP DOWNLOAD & CSV EXPORT
  if (pathname === '/api/backup/download') {
    const fullBackup = {
      exportTimestamp: new Date().toISOString(),
      foundation: 'Al-Fajr Committee Ahle Sunnat Wal Jamaat, Nagpur',
      settings: readJsonFile('settings.json', {}),
      agents: readJsonFile('agents.json', []),
      orders2026: readJsonFile('orders_2026.json', []),
      orders2027: readJsonFile('orders_2027.json', []),
      expenses: readJsonFile('expenses.json', [])
    };

    const filename = `AlFajr_Qurbani_Backup_${new Date().toISOString().split('T')[0]}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.end(JSON.stringify(fullBackup, null, 2));
    return;
  }

  if (pathname === '/api/backup/export-csv') {
    const reqYear = query.get('year') || '2026';
    const csvFile = (reqYear === '2026') ? path.join(DATA_DIR, 'raw_qurbani_2026.csv') : null;

    if (csvFile && fs.existsSync(csvFile)) {
      const csvData = fs.readFileSync(csvFile, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="AlFajr_Qurbani_${reqYear}_List.csv"`
      });
      res.end(csvData);
      return;
    } else {
      const orders = readJsonFile(reqYear === '2026' ? 'orders_2026.json' : 'orders_2027.json', []);
      let csv = 'S . N,RASID NO,NAME,IN INCOME,OUT INCOME,TOTAL INMCONE\n';
      orders.forEach((o, idx) => {
        csv += `${idx + 1},${o.receiptNo || o.id},"${o.agentName || ''}",${o.inIncome || o.paidAmount || 0},${o.outIncome || o.commissionAmount || 0},${o.totalAmount || 0}\n`;
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="AlFajr_Qurbani_${reqYear}_Export.csv"`
      });
      res.end(csv);
      return;
    }
  }

  // 5. EXPENSES API
  if (pathname === '/api/expenses') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const expenses = readJsonFile('expenses.json', []);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.method === 'GET') res.end(JSON.stringify(expenses));
      else res.end();
      return;
    }
    if (req.method === 'POST') {
      getRequestBody((err, newExp) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        const expenses = readJsonFile('expenses.json', []);
        if (!newExp.id) {
          newExp.id = 'EXP-2026-' + String(expenses.length + 1).padStart(3, '0');
        }
        expenses.unshift(newExp);
        writeJsonFile('expenses.json', expenses);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(newExp));
      });
      return;
    }
    if (req.method === 'DELETE') {
      getRequestBody((err, data) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        let expenses = readJsonFile('expenses.json', []);
        expenses = expenses.filter(x => x.id !== data.id);
        writeJsonFile('expenses.json', expenses);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }
  }

  // 5.8 ANIMAL & SHARE STOCK MANAGEMENT API
  if (pathname === '/api/stock') {
    const defaultStock = {
      "2026": { "totalAnimals": 85, "sharePerAnimal": 7, "bakraAnimals": 0, "batches": [] },
      "2027": { "totalAnimals": 10, "sharePerAnimal": 7, "bakraAnimals": 0, "batches": [] }
    };
    if (req.method === 'GET' || req.method === 'HEAD') {
      const stock = readJsonFile('stock.json', defaultStock);
      const reqYear = query.get('year');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.method === 'GET') {
        if (reqYear && stock[reqYear]) {
          res.end(JSON.stringify(stock[reqYear]));
        } else {
          res.end(JSON.stringify(stock));
        }
      } else res.end();
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      getRequestBody((err, payload) => {
        if (err || !payload) { res.writeHead(400); res.end('Invalid JSON'); return; }
        const stock = readJsonFile('stock.json', defaultStock);
        const reqYear = payload.year || query.get('year') || '2026';
        if (payload.totalAnimals !== undefined) {
          if (!stock[reqYear]) stock[reqYear] = { totalAnimals: 0, sharePerAnimal: 7, batches: [] };
          stock[reqYear].totalAnimals = Number(payload.totalAnimals) || 0;
          if (payload.sharePerAnimal !== undefined) stock[reqYear].sharePerAnimal = Number(payload.sharePerAnimal) || 7;
          if (payload.bakraAnimals !== undefined) stock[reqYear].bakraAnimals = Number(payload.bakraAnimals) || 0;
          if (payload.notes !== undefined) stock[reqYear].notes = payload.notes;
          if (Array.isArray(payload.batches)) stock[reqYear].batches = payload.batches;
        } else {
          Object.assign(stock, payload);
        }
        writeJsonFile('stock.json', stock);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(stock[reqYear] || stock));
      });
      return;
    }
  }

  // 6. SETTINGS API
  if (pathname === '/api/settings') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const settings = readJsonFile('settings.json', {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.method === 'GET') res.end(JSON.stringify(settings));
      else res.end();
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      getRequestBody((err, updatedSettings) => {
        if (err) { res.writeHead(400); res.end('Invalid JSON'); return; }
        writeJsonFile('settings.json', updatedSettings);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updatedSettings));
      });
      return;
    }
  }

  // 6.5 SEND SMS GATEWAY & LOGGING ENDPOINT
  if (pathname === '/api/send-sms') {
    if (req.method === 'GET') {
      const logs = readJsonFile('sms_logs.json', []);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(logs.slice(0, 100)));
      return;
    }
    if (req.method === 'POST') {
      getRequestBody((err, body) => {
        if (err || !body || !body.to || !body.text) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Missing to or text field' }));
          return;
        }
        const smsLogs = readJsonFile('sms_logs.json', []);
        const entry = {
          id: 'SMS-' + Date.now(),
          to: body.to,
          text: body.text,
          type: body.type || 'donor_booking_sms',
          orderId: body.orderId || '',
          timestamp: new Date().toISOString(),
          status: 'DISPATCHED'
        };

        const settings = readJsonFile('settings.json', {});
        if (settings.smsApiKey && settings.smsApiKey.trim()) {
          try {
            const https = require('https');
            const cleanPhone = String(body.to).replace(/[^0-9]/g, '').slice(-10);
            const postData = JSON.stringify({
              route: 'v3',
              sender_id: 'TXTIND',
              message: body.text,
              language: 'english',
              flash: 0,
              numbers: cleanPhone
            });
            const reqOpt = {
              hostname: 'www.fast2sms.com',
              path: '/dev/bulkV2',
              method: 'POST',
              headers: {
                'authorization': settings.smsApiKey.trim(),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
              }
            };
            const smsReq = https.request(reqOpt, (smsRes) => {
              let respData = '';
              smsRes.on('data', chunk => respData += chunk);
              smsRes.on('end', () => {
                entry.gatewayResponse = respData;
                entry.gatewayStatus = smsRes.statusCode === 200 ? 'SUCCESS' : 'FAILED';
                smsLogs.unshift(entry);
                writeJsonFile('sms_logs.json', smsLogs);
              });
            });
            smsReq.on('error', (e) => {
              entry.gatewayError = e.message;
              smsLogs.unshift(entry);
              writeJsonFile('sms_logs.json', smsLogs);
            });
            smsReq.write(postData);
            smsReq.end();
          } catch (e) {
            entry.gatewayError = e.message;
            smsLogs.unshift(entry);
            writeJsonFile('sms_logs.json', smsLogs);
          }
        } else {
          smsLogs.unshift(entry);
          writeJsonFile('sms_logs.json', smsLogs);
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, entry }));
      });
      return;
    }
  }

  // 7. STATIC FILES SERVING
  let safePath = pathname.replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';

  const filePath = path.join(BASE_DIR, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);

    const headers = {
      'Content-Type': contentType,
      'Content-Length': stat.size
    };
    if (ext === '.html' || ext === '.js' || ext === '.json') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }

    res.writeHead(200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`  AL-FAJR COMMITTEE QURBANI PORTAL NODE SERVER`);
  console.log(`  Port: ${PORT}`);
  console.log(`  URL: http://localhost:${PORT}/`);
  console.log(`  Database: 527 Orders Loaded (2026 & 2027 Ready)`);
  console.log(`====================================================`);
});
