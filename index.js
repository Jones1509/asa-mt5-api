const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

let accountData = {};
let openTrades = [];
let closedTrades = [];
let pendingCommands = [];
let commandResults = [];
let botSettings = {
  running: true,
  maxTrades: 10,
  riskPercent: 1.0,
  maxLot: 1.0,
  sl_multi: 3.0,
  tp_multi: 7.0,
  start_hour: 8,
  end_hour: 20,
  symbols: ["XAUUSD","XAGUSD","EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","NZDUSD","USDCAD","EURJPY","GBPJPY"]
};

app.post('/api/account', (req, res) => {
  accountData = req.body;
  openTrades = req.body.positions || [];
  if(req.body.bot_running !== undefined) botSettings.running = req.body.bot_running;
  console.log('Account update:', req.body.bot, 'Balance:', req.body.balance, 'Tid:', req.body.timestamp);
  res.json({ status: 'ok' });
});

app.get('/api/commands/pending', (req, res) => {
  if(pendingCommands.length === 0) { res.json({}); return; }
  const cmd = pendingCommands.shift();
  res.json(cmd);
});

app.post('/api/command/result', (req, res) => {
  commandResults.unshift({ ...req.body, timestamp: new Date().toISOString() });
  if(commandResults.length > 50) commandResults.pop();
  res.json({ status: 'ok' });
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
  if(command === 'stop') botSettings.running = false;
  if(command === 'start') botSettings.running = true;
  if(command === 'set_risk') botSettings.riskPercent = value;
  if(command === 'set_max_trades') botSettings.maxTrades = value;
  if(command === 'set_max_lot') botSettings.maxLot = value;
  res.json({ status: 'ok', message: 'Kommando sendt til MT5' });
});

app.post('/api/trade/open', (req, res) => {
  console.log('Trade åbnet:', req.body.symbol, req.body.direction);
  res.json({ status: 'ok' });
});

app.post('/api/trade/close', (req, res) => {
  closedTrades.unshift(req.body);
  if(closedTrades.length > 1000) closedTrades.pop();
  console.log('Trade lukket:', req.body.symbol, 'profit:', req.body.profit);
  res.json({ status: 'ok' });
});

app.get('/api/status', (req, res) => {
  const totalProfit = closedTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
  const winningTrades = closedTrades.filter(t => t.profit > 0);
  const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length * 100).toFixed(1) : 0;
  const bestTrade = closedTrades.reduce((best, t) => t.profit > (best?.profit || -Infinity) ? t : best, null);
  const worstTrade = closedTrades.reduce((worst, t) => t.profit < (worst?.profit || Infinity) ? t : worst, null);
  const profitBySymbol = {};
  closedTrades.forEach(t => {
    if(!profitBySymbol[t.symbol]) profitBySymbol[t.symbol] = { trades: 0, profit: 0, wins: 0 };
    profitBySymbol[t.symbol].trades++;
    profitBySymbol[t.symbol].profit += t.profit || 0;
    if(t.profit > 0) profitBySymbol[t.symbol].wins++;
  });
  res.json({
    account: accountData,
    open_trades: openTrades,
    closed_trades: closedTrades,
    settings: botSettings,
    command_results: commandResults,
    stats: {
      total_profit: totalProfit,
      win_rate: winRate,
      total_trades: closedTrades.length,
      winning_trades: winningTrades.length,
      best_trade: bestTrade,
      worst_trade: worstTrade,
      profit_by_symbol: profitBySymbol
    }
  });
});

app.get('/api/ping', (req, res) => res.json({ status: 'pong', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ASA MT5 API kører på port ' + PORT));
