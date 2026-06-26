import express from 'express';
import { readRecords, getRecordsBySerial, getFailedRecords, getPassedRecords, getUniqueSerials } from '../data/dataReader.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const records = readRecords();
    res.json({ total: records.length, records });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read CSV data' });
  }
});

router.get('/summary', (req, res) => {
  try {
    const all = readRecords();
    const failed = getFailedRecords();
    const passed = getPassedRecords();
    const serials = getUniqueSerials();
    res.json({
      total: all.length,
      passed: passed.length,
      failed: failed.length,
      uniqueSerials: serials.length,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read CSV data' });
  }
});

router.get('/failed', (req, res) => {
  try {
    const records = getFailedRecords();
    res.json({ total: records.length, records });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read CSV data' });
  }
});

router.get('/serial/:serialNumber', (req, res) => {
  try {
    const records = getRecordsBySerial(req.params.serialNumber);
    res.json({ total: records.length, records });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read CSV data' });
  }
});

export default router;
