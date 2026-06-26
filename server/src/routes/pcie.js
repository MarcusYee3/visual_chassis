import express from 'express';
import { getPCIePorts, updatePCIePort } from '../data/serverData.js';

const router = express.Router({ mergeParams: true });

// GET /api/servers/:serverId/gbb/osfp/:osfpId/pcie - Get all PCIe ports
router.get('/', (req, res) => {
  try {
    const { osfpId } = req.params;
    const ports = getPCIePorts(osfpId);

    if (!ports.length) {
      return res.status(404).json({ error: 'OSFP module not found' });
    }

    res.json(ports);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch PCIe ports' });
  }
});

// PUT /api/servers/:serverId/gbb/osfp/:osfpId/pcie/:pcieId - Update PCIe port
router.put('/:pcieId', (req, res) => {
  try {
    const { osfpId, pcieId } = req.params;
    const { status } = req.body;

    const updatedPort = updatePCIePort(osfpId, pcieId, status);

    if (!updatedPort) {
      return res.status(404).json({ error: 'PCIe port not found' });
    }

    res.json(updatedPort);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update PCIe port' });
  }
});

export default router;
