import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import serversRouter from './routes/servers.js';
import osfpRouter from './routes/osfp.js';
import pcieRouter from './routes/pcie.js';
import psuRouter from './routes/psu.js';
import diagnoseRouter from './routes/diagnose.js';
import validateSnRouter from './routes/validateSn.js';

dotenv.config();

const app = express();
// 5000 collides with macOS AirPlay Receiver (AirTunes), which answers with an
// empty 403 on that port and breaks JSON parsing on the client — default elsewhere.
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

app.use('/api/servers', serversRouter);
app.use('/api/servers/:serverId/gbb/osfp', osfpRouter);
app.use('/api/servers/:serverId/gbb/osfp/:osfpId/pcie', pcieRouter);
app.use('/api/servers/:serverId/psu', psuRouter);
app.use('/api/servers/:serverId/diagnose', diagnoseRouter);
app.use('/api/validate-sn', validateSnRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`✅ API available at http://localhost:${PORT}/api`);
});
