import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import serversRouter from './routes/servers.js';
import osfpRouter from './routes/osfp.js';
import pcieRouter from './routes/pcie.js';
import psuRouter from './routes/psu.js';
import reportsRouter from './routes/reports.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/servers', serversRouter);
app.use('/api/servers/:serverId/gbb/osfp', osfpRouter);
app.use('/api/servers/:serverId/gbb/osfp/:osfpId/pcie', pcieRouter);
app.use('/api/servers/:serverId/psu', psuRouter);
app.use('/api/reports', reportsRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`✅ API available at http://localhost:${PORT}/api`);
});
