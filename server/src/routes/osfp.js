import express from 'express';
import { getAllOSFPModules, getOSFPModule } from '../data/serverData.js';

const router = express.Router({ mergeParams: true });

// GET /api/servers/:serverId/gbb/osfp - Get all OSFP modules
router.get('/', (req, res) => {
  try {
    const modules = getAllOSFPModules();
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch OSFP modules' });
  }
});

// GET /api/servers/:serverId/gbb/osfp/:osfpId - Get specific OSFP module
router.get('/:osfpId', (req, res) => {
  try {
    const { osfpId } = req.params;
    const module = getOSFPModule(osfpId);

    if (!module) {
      return res.status(404).json({ error: 'OSFP module not found' });
    }

    res.json(module);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch OSFP module' });
  }
});

export default router;
