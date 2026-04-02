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
  // Migrer account_data fra INTEGER id til TEXT id hvis nødvendigt
  try {
    const col = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'account_data' AND column_name = 'id'
    `);
    if (col.rows.length > 0 && col.rows[0].data_type === 'integer') {
      console.log('Migrerer account_data tabel fra INTEGER til TEXT id...');
      await pool.query(`
        ALTER TABLE account_data RENAME TO account_data_old;
        CREATE TABLE account_data (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        INSERT INTO account_data (id, data) SELECT '1', data FROM account_data_old WHERE id = 1;
        DROP TABLE account_data_old;
      `);
      console.log('Migration færdig!');
    }
  } catch(e) {
    console.log('Migration check:', e.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_data (
      id TEXT PRIMARY KEY,
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
      bot TEXT,
      timestamp TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS open_trades (
      ticket BIGINT PRIMARY KEY,
      symbol TEXT,
      direction TEXT,
      lot FLOAT,
      open_price FLOAT,
      current_price FLOAT,
      profit FLOAT,
      sl FLOAT,
      tp FLOAT,
      bot TEXT,
      open_time TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
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
    INSERT INTO account_data (id, data) VALUES ('metals', '{}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO account_data (id, data) VALUES ('major', '{}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO account_data (id, data) VALUES ('yen', '{}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO account_data (id, data) VALUES ('combined', '{}') ON CONFLICT (id) DO NOTHING;
  `);
  console.log('Database initialiseret!');
}

// ============================================================
// MT5 SENDER ACCOUNT DATA
// ============================================================
app.post('/api/account', async (req, res) => {
  try {
    const body = req.body;
    const bot = body.bot || 'unknown';

    // Gem per bot
    await pool.query(
      'INSERT INTO account_data (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
      [bot, body]
    );

    // Sync åbne trades fra positions array
    if (body.positions && Array.isArray(body.positions)) {
      // Slet gamle åbne trades for denne bot
      await pool.query('DELETE FROM open_trades WHERE bot = $1', [bot]);
      // Indsæt nye
      for (const pos of body.positions) {
        await pool.query(`
          INSERT INTO open_trades (ticket, symbol, direction, lot, open_price, current_price, profit, sl, tp, bot, open_time, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
          ON CONFLICT (ticket) DO UPDATE SET
            current_price = $6, profit = $7, sl = $8, tp = $9, updated_at = NOW()
        `, [
          pos.ticket, pos.symbol, pos.direction, pos.volume ?? pos.lot,
          pos.open_price, pos.current_price, pos.profit,
          pos.sl, pos.tp, bot, pos.open_time
        ]);
      }
    }

    // Opdater combined (seneste balance fra en hvilken som helst bot)
    const metals = await pool.query("SELECT data FROM account_data WHERE id = 'metals'");
    const major  = await pool.query("SELECT data FROM account_data WHERE id = 'major'");
    const yen    = await pool.query("SELECT data FROM account_data WHERE id = 'yen'");

    const mData = metals.rows[0]?.data || {};
    const majData = major.rows[0]?.data || {};
    const yData = yen.rows[0]?.data || {};

    // Balance er den samme konto — brug den mest opdaterede
    const combined = {
      balance: body.balance,
      equity: body.equity,
      floating_profit: (mData.floating_profit || 0) + (majData.floating_profit || 0) + (yData.floating_profit || 0),
      open_trades: (mData.open_trades || 0) + (majData.open_trades || 0) + (yData.open_trades || 0),
      bot_running: mData.bot_running || majData.bot_running || yData.bot_running || false,
      last_update: new Date().toISOString(),
      metals: mData,
      major: majData,
      yen: yData
    };

    await pool.query(
      'INSERT INTO account_data (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
      ['combined', combined]
    );

    console.log(`Account update: ${bot} | Balance: ${body.balance} | Equity: ${body.equity} | Open: ${body.open_trades}`);
    res.json({ status: 'ok' });
  } catch(e) {
    console.error('Account update fejl:', e);
    res.json({ status: 'error', message: e.message });
  }
});

// ============================================================
// MT5 HENTER KOMMANDOER
// ============================================================
app.get('/api/commands/pending', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, command FROM commands ORDER BY created_at ASC LIMIT 1');
    if (result.rows.length === 0) { res.json({}); return; }
    const row = result.rows[0];
    await pool.query('DELETE FROM commands WHERE id = $1', [row.id]);
    console.log('Kommando sendt til MT5:', row.command);
    res.json(row.command);
  } catch(e) {
    console.error('Pending commands fejl:', e);
    res.json({});
  }
});

// ============================================================
// MT5 SENDER KOMMANDO RESULTAT
// ============================================================
app.post('/api/command/result', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO command_results (result) VALUES ($1)',
      [{ ...req.body, timestamp: new Date().toISOString() }]
    );
    console.log('Kommando resultat:', req.body);
    res.json({ status: 'ok' });
  } catch(e) {
    res.json({ status: 'error' });
  }
});

// ============================================================
// LOVABLE SENDER KOMMANDO
// ============================================================
app.post('/api/command', async (req, res) => {
  const { command, value, symbol, ticket, minutes, start_hour, end_hour } = req.body;

  // Brug "action" felt — det er hvad MT5 forventer
  let cmd = { action: command };
  if (value !== undefined) cmd.value = value;
  if (symbol)      cmd.symbol = symbol;
  if (ticket)      cmd.ticket = ticket;
  if (minutes)     cmd.minutes = minutes;
  if (start_hour)  cmd.start_hour = start_hour;
  if (end_hour)    cmd.end_hour = end_hour;

  try {
    await pool.query('INSERT INTO commands (command) VALUES ($1)', [cmd]);
    console.log('Kommando gemt til MT5:', cmd);
    res.json({ status: 'ok', message: `Kommando "${command}" sendt til MT5`, command: cmd });
  } catch(e) {
    console.error('Command fejl:', e);
    res.json({ status: 'error', message: e.message });
  }
});

// ============================================================
// MT5 SENDER ÅBNET TRADE
// ============================================================
app.post('/api/trade/open', async (req, res) => {
  try {
    const { ticket, symbol, direction, lot, open_price, sl, tp, bot, timestamp } = req.body;
    await pool.query(`
      INSERT INTO open_trades (ticket, symbol, direction, lot, open_price, current_price, profit, sl, tp, bot, open_time, updated_at)
      VALUES ($1,$2,$3,$4,$5,$5,0,$6,$7,$8,$9,NOW())
      ON CONFLICT (ticket) DO UPDATE SET updated_at = NOW()
    `, [ticket, symbol, direction, lot, open_price, sl, tp, bot || 'unknown', timestamp]);
    console.log(`Trade åbnet: ${symbol} ${direction} lot:${lot} @ ${open_price}`);
    res.json({ status: 'ok' });
  } catch(e) {
    console.error('Trade open fejl:', e);
    res.json({ status: 'error', message: e.message });
  }
});

// ============================================================
// MT5 SENDER LUKKET TRADE
// ============================================================
app.post('/api/trade/close', async (req, res) => {
  try {
    const { ticket, symbol, direction, lot, open_price, close_price, profit, bot, timestamp } = req.body;

    // Gem i historik
    await pool.query(
      'INSERT INTO trades (ticket, symbol, direction, lot, open_price, close_price, profit, bot, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [ticket, symbol, direction, lot, open_price, close_price, profit, bot || 'unknown', timestamp]
    );

    // Fjern fra åbne trades
    await pool.query('DELETE FROM open_trades WHERE ticket = $1', [ticket]);

    console.log(`Trade lukket: ${symbol} ${direction} profit:${profit}`);
    res.json({ status: 'ok' });
  } catch(e) {
    console.error('Trade close fejl:', e);
    res.json({ status: 'error', message: e.message });
  }
});

// ============================================================
// LOVABLE HENTER STATUS
// ============================================================
app.get('/api/status', async (req, res) => {
  try {
    // Account data per bot
    const accountResult = await pool.query('SELECT id, data FROM account_data');
    const accountMap = {};
    accountResult.rows.forEach(r => { accountMap[r.id] = r.data; });

    const combined   = accountMap['combined'] || {};
    const metalsData = accountMap['metals']   || {};
    const majorData  = accountMap['major']    || {};
    const yenData    = accountMap['yen']      || {};

    // Åbne trades fra database
    const openResult = await pool.query('SELECT * FROM open_trades ORDER BY open_time DESC');
    const openTrades = openResult.rows;

    // Lukkede trades
    const tradesResult = await pool.query('SELECT * FROM trades ORDER BY created_at DESC LIMIT 1000');
    const closedTrades = tradesResult.rows;

    // Kommando resultater
    const resultsResult = await pool.query('SELECT result FROM command_results ORDER BY created_at DESC LIMIT 50');
    const commandResults = resultsResult.rows.map(r => r.result);

    // Stats
    const totalProfit   = closedTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const winningTrades = closedTrades.filter(t => t.profit > 0);
    const winRate       = closedTrades.length > 0
      ? (winningTrades.length / closedTrades.length * 100).toFixed(1)
      : 0;

    const profitBySymbol = {};
    closedTrades.forEach(t => {
      if (!profitBySymbol[t.symbol]) profitBySymbol[t.symbol] = { trades: 0, profit: 0, wins: 0 };
      profitBySymbol[t.symbol].trades++;
      profitBySymbol[t.symbol].profit += t.profit || 0;
      if (t.profit > 0) profitBySymbol[t.symbol].wins++;
    });

    const profitByBot = {};
    closedTrades.forEach(t => {
      const b = t.bot || 'unknown';
      if (!profitByBot[b]) profitByBot[b] = { trades: 0, profit: 0, wins: 0 };
      profitByBot[b].trades++;
      profitByBot[b].profit += t.profit || 0;
      if (t.profit > 0) profitByBot[b].wins++;
    });

    res.json({
      // Primære account data (combined)
      account: {
        ...combined,
        balance:  combined.balance  || metalsData.balance  || majorData.balance  || yenData.balance  || 0,
        equity:   combined.equity   || metalsData.equity   || majorData.equity   || yenData.equity   || 0,
        floating_profit: combined.floating_profit || 0,
        open_trades: openTrades.length,
        bot_running: combined.bot_running || false,
        last_update: combined.last_update || null,
      },
      // Per bot data
      bots: {
        metals: metalsData,
        major:  majorData,
        yen:    yenData,
      },
      open_trades:    openTrades,
      closed_trades:  closedTrades,
      command_results: commandResults,
      stats: {
        total_profit:    totalProfit,
        win_rate:        winRate,
        total_trades:    closedTrades.length,
        winning_trades:  winningTrades.length,
        profit_by_symbol: profitBySymbol,
        profit_by_bot:    profitByBot,
      }
    });
  } catch(e) {
    console.error('Status fejl:', e);
    res.json({ error: e.message });
  }
});

app.get('/api/ping', (req, res) => res.json({ status: 'pong', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('ASA MT5 API kører på port ' + PORT));
});
