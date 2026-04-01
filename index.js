const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

let accountData = {};
let openTrades = [];
let closedTrades = [];

app.post('/api/account', (req, res) => {
  accountData = req.body;
  openTrades = req.body.positions || [];
  console.log('Account update:', accountData.balance);
  res.json({ status: 'ok' });
});

app.post('/api/trade/open', (req, res) => {
  console.log('Trade opened:', req.body.symbol);
  res.json({ status: 'ok' });
});

app.post('/api/trade/close', (req, res) => {
  closedTrades.unshift(req.body);
  if (closedTrades.length > 500) closedTrades.pop();
  console.log('Trade closed:', req.body.symbol, req.body.profit);
  res.json({ status: 'ok' });
});

app.get('/api/status', (req, res) => {
  res.json({ account: accountData, open_trades: openTrades, closed_trades: closedTrades });
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'pong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MT5 API kører på port ' + PORT));
