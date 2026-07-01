import express from 'express';
import { exec } from 'child_process';

const router = express.Router();

router.get('/', (req, res) => {
  const { sn } = req.query;
  if (!sn) return res.status(400).json({ error: 'sn query param required' });

  // Prevent command injection
  if (!/^[a-zA-Z0-9]+$/.test(sn)) {
    return res.status(400).json({ error: 'Invalid SN format' });
  }

  exec(`python3 /home/tester/WesleyH/eve.ip.pyc ${sn}`, (error, stdout, stderr) => {
    const output = stdout + stderr;
    console.log('[validate-sn] error:', error?.message);
    console.log('[validate-sn] output:', output.trim());

    if (error && !output.trim()) {
      return res.status(503).json({ error: `eve_ip failed: ${error.message}` });
    }

    const isError = /not subscriptable|NoneType|TypeError|Traceback|command not found/i.test(output);
    const ipMatch = output.match(/(\d{1,3}(?:\.\d{1,3}){3})/);

    if (isError || !ipMatch) {
      res.json({ valid: false });
    } else {
      res.json({ valid: true, ilomIp: ipMatch[1] });
    }
  });
});

export default router;
