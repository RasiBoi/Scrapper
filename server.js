const express = require('express');
const path = require('path');

// Reuse the same lookup handler from the Vercel function
const lookupHandler = require('./api/lookup');

const app = express();
const PORT = 4000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Mount the Vercel serverless function as a local Express route
// This means the frontend's /api/lookup calls work identically locally and on Vercel
app.get('/api/lookup', (req, res) => {
  lookupHandler(req, res);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));

app.listen(PORT, () => {
  console.log(`\n🚀 PEPPOL AP Scraper running at: http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
