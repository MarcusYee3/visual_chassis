import express from 'express';
import { getServerData, updateServerData, getGBBTray } from '../data/serverData.js';

const router = express.Router();

// GET /api/servers/:serverId - Get server details
router.get('/:serverId', (req, res) => {
  try {
    const server = getServerData();
    res.json(server);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch server data' });
  }
});

// PUT /api/servers/:serverId - Update server info
router.put('/:serverId', (req, res) => {
  try {
    const { name, serialNumber } = req.body;
    const updated = updateServerData({ name, serialNumber });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update server data' });
  }
});

// GET /api/servers/:serverId/gbb - Get GBB tray data
router.get('/:serverId/gbb', (req, res) => {
  try {
    const gbbTray = getGBBTray();
    res.json(gbbTray);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch GBB tray data' });
  }
});

export default router;
