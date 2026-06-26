import express from 'express';
import { getPSUPorts } from '../data/serverData.js';

const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  try {
    const ports = getPSUPorts();
    res.json(ports);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch PSU ports' });
  }
});

export default router;
