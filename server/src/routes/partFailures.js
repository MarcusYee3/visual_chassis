import express from 'express';
import { findExisting, logFailure, getAllFailures } from '../data/partFailuresDb.js';

const router = express.Router();

// GET /api/part-failures                          -> full log, newest first
// GET /api/part-failures?serialNumber=X&partId=Y   -> prior loggings of that exact SN+part
router.get('/', (req, res) => {
  const { serialNumber, partId } = req.query;
  if (serialNumber && partId) {
    return res.json(findExisting(serialNumber, partId));
  }
  res.json(getAllFailures());
});

// POST /api/part-failures - the client is expected to have already called the GET above and
// gotten user confirmation if a prior entry existed; this endpoint always inserts.
router.post('/', (req, res) => {
  const { serialNumber, partId, partLabel, checkName, source, rawDetail } = req.body || {};
  if (!serialNumber || !partId || !partLabel) {
    return res.status(400).json({ error: 'serialNumber, partId, and partLabel are required' });
  }
  const entry = logFailure({ serialNumber, partId, partLabel, checkName, source, rawDetail });
  res.status(201).json(entry);
});

export default router;
