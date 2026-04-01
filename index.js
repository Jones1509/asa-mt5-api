const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

let accountData = {};
let openTrades = [];
let closedTrades = [];
let botSettings = {
  running: true,
  maxTrades: 20,
  riskPercent: 0.5,
  maxLot: 0.5,
  symbols: ["XAUUSD", "XAGUSD", "USOIL"]
};
let pendingCommands = [];
let alerts = [];

// MT5 sender data her
app.post('/api/account', (req, res) => {
  accountData = req.body;
  openTrades = req.body.positions || [];
  res.json({ status: 'ok', pending_commands: pendingCommands.splice(0) });
});

app.post('/api/trade/open', (req, res) => {
  console.log('Trade opened:', req.body.symbol);
  res.json({ status: 'ok' });
});

app.post('/api/trade/close', (req, res) => {
  closedTrades.unshift(req.body);
  if (closedTrades.length > 500) closedTrades.pop();
  res.json({ status: 'ok' });
});

// Lovable henter data her
app.get('/api/status', (req, res) => {
  const totalProfit = closedTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
  const winningTrades = closedTrades.filter(t => t.profit > 0);
  const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length * 100).toFixed(1) : 0;
  const bestTrade = closedTrades.reduce((best, t) => t.profit > (best?.profit || -Infinity) ? t : best, null);
  const worstTrade = closedTrades.reduce((worst, t) => t.profit < (worst?.profit || Infinity) ? t : worst, null);
  
  res.json({
    account: accountData,
    open_trades: openTrades,
    closed_trades: closedTrades,
    settings: botSettings,
    stats: {
      total_profit: totalProfit,
      win_rate: winRate,
      total_trades: closedTrades.length,
      winning_trades: winningTrades.length,
      best_trade: bestTrade,
      worst_trade: worstTrade
    }
  });
});

// AI kommandoer
app.post('/api/command', (req, res) => {
  const { command, value, symbol } = req.body;
  
  switch(command) {
    case 'close_all':
      pendingCommands.push({ action: 'close_all' });
      res.json({ success: true, message: 'Lukker alle handler...' });
      break;
    case 'close_symbol':
      pendingCommands.push({ action: 'close_symbol', symbol });
      res.json({ success: true, message: `Lukker alle ${symbol} handler...` });
      break;
    case 'close_losing':
      pendingCommands.push({ action: 'close_losing' });
      res.json({ success: true, message: 'Lukker alle tabende handler...' });
      break;
    case 'stop':
      botSettings.running = false;
      pendingCommands.push({ action: 'stop' });
      res.json({ success: true, message: 'Stopper botten...' });
      break;
    case 'start':
      botSettings.running = true;
      pendingCommands.push({ action: 'start' });
      res.json({ success: true, message: 'Starter botten...' });
      break;
    case 'set_risk':
      botSettings.riskPercent = value;
      pendingCommands.push({ action: 'set_risk', value });
      res.json({ success: true, message: `Risk sat til ${value}%` });
      break;
    case 'set_max_trades':
      botSettings.maxTrades = value;
      pendingCommands.push({ action: 'set_max_trades', value });
      res.json({ success: true, message: `Max trades sat til ${value}` });
      break;
    case 'set_max_lot':
      botSettings.maxLot = value;
      pendingCommands.push({ action: 'set_max_lot', value });
      res.json({ success: true, message: `Max lot sat til ${value}` });
      break;
    case 'add_alert':
      alerts.push({ type: value.type, threshold: value.threshold });
      res.json({ success: true, message: `Alert tilføjet` });
      break;
    default:
      res.json({ success: false, message: 'Ukendt kommando' });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'pong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MT5 API kører på port ' + PORT));