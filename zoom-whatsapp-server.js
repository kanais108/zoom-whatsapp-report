require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.send('Zoom WhatsApp server is running');
});

const port = process.env.PORT || 3000;

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  console.log(`Health check: /health`);
});