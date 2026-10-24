'use strict';

const { checkInteractions } = require('../lib/engine');

// POST /api/check   body: { "drugs": ["warfarin", "aspirin"] }
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const result = await checkInteractions(body.drugs, { apiKey: process.env.OPENFDA_API_KEY });
    return res.status(200).json(result);
  } catch (e) {
    const status = e.statusCode || (e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error('check failed:', e);
    return res.status(status).json({
      error: status === 500 ? 'Something went wrong while checking interactions.' : e.message,
    });
  }
};
