const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_data (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      ticket BIGINT,
      symbol TEXT,
      direction TEXT,
      lot FLOAT,
      open_price FLOAT,
      close_price FLOAT,
      profit FLOAT,
      timestamp TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS commands (
      id SERIAL PRIMARY KEY,
      command JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS command_results (
      id SERIAL PRIMARY KEY,
      result JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    INSERT INTO account_data (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;
  `);
  console.log('Database initialiseret!');
}

let pendingCommands = [];

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.post('/api/account', async (req, res) => {
  try {
    await pool.query('UPDATE account_data SET data = $1 WHERE id = 1', [req.body]);
    console.log('Account update:', req.body.bot, 'Balance:', req.body.balance);
    res.json({ status: 'ok' });
  } catch(e) {
    console.error(e);
    res.json({ status: 'error' });
  }
});

app.get('/api/commands/pending', (req, res) => {
  if(pendingCommands.length === 0) { res.json({}); return; }
  const cmd = pendingCommands.shift();
  res.json(cmd);
});

app.post('/api/command/result', async (req, res) => {
  try {
    await pool.query('INSERT INTO command_results (result) VALUES ($1)', [{ ...req.body, timestamp: new Date().toISOString() }]);
    res.json({ status: 'ok' });
  } catch(e) {
    res.json({ status: 'error' });
  }
});

app.post('/api/command', (req, res) => {
  const { command, value, symbol, ticket, minutes, start_hour, end_hour } = req.body;
  let cmd = { action: command };
  if(value !== undefined) cmd.value = value;
  if(symbol) cmd.symbol = symbol;
  if(ticket) cmd.ticket = ticket;
  if(minutes) cmd.minutes = minutes;
  if(start_hour) cmd.start_hour = start_hour;
  if(end_hour) cmd.end_hour = end_hour;
  pendingCommands.push(cmd);
  res.json({ status: 'ok', message: 'Kommando sendt til MT5' });
});

app.post('/api/trade/open', (req, res) => {
  console.log('Trade åbnet:', req.body.symbol, req.body.direction);
  res.json({ status: 'ok' });
});

app.post('/api/trade/close', async (req, res) => {
  try {
    const { ticket, symbol, direction, lot, open_price, close_price, profit, timestamp } = req.body;
    await pool.query(
      'INSERT INTO trades (ticket, symbol, direction, lot, open_price, close_price, profit, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [ticket, symbol, direction, lot, open_price, close_price, profit, timestamp]
    );
    console.log('Trade lukket:', symbol, 'profit:', profit);
    res.json({ status: 'ok' });
  } catch(e) {
    console.error(e);
    res.json({ status: 'error' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const accountResult = await pool.query('SELECT data FROM account_data WHERE id = 1');
    const accountData = accountResult.rows[0]?.data || {};
    const tradesResult = await pool.query('SELECT * FROM trades ORDER BY created_at DESC LIMIT 1000');
    const closedTrades = tradesResult.rows;
    const resultsResult = await pool.query('SELECT result FROM command_results ORDER BY created_at DESC LIMIT 50');
    const commandResults = resultsResult.rows.map(r => r.result);
    const totalProfit = closedTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const winningTrades = closedTrades.filter(t => t.profit > 0);
    const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length * 100).toFixed(1) : 0;
    const profitBySymbol = {};
    closedTrades.forEach(t => {
      if(!profitBySymbol[t.symbol]) profitBySymbol[t.symbol] = { trades: 0, profit: 0, wins: 0 };
      profitBySymbol[t.symbol].trades++;
      profitBySymbol[t.symbol].profit += t.profit || 0;
      if(t.profit > 0) profitBySymbol[t.symbol].wins++;
    });
    res.json({
      account: accountData,
      open_trades: accountData.positions || [],
      closed_trades: closedTrades,
      command_results: commandResults,
      stats: {
        total_profit: totalProfit,
        win_rate: winRate,
        total_trades: closedTrades.length,
        winning_trades: winningTrades.length,
        profit_by_symbol: profitBySymbol
      }
    });
  } catch(e) {
    console.error(e);
    res.json({ error: e.message });
  }
});

app.get('/api/ping', (req, res) => res.json({ status: 'pong', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('ASA MT5 API med database kører på port ' + PORT));
});
