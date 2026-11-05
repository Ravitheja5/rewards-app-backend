const { db } = require('../config/firebase');
const WalletService = require('../services/walletService');

exports.handleAffiliatePostback = async (req, res) => {
  try {
    const {
      click_id,
      conversion_id,
      payout,
      status,
      network = 'vcommission'
    } = { ...req.query, ...req.body };

    if (!click_id || !conversion_id) {
      return res.status(400).json({ error: 'Missing click_id or conversion_id' });
    }

    const idempotencyDocId = `${network}_${conversion_id}`;
    const conversionRef = db.collection('conversions').doc(idempotencyDocId);

    const clickDoc = await db.collection('affiliate_clicks').doc(click_id).get();
    if (!clickDoc.exists) {
      return res.status(404).json({ error: 'Click reference not found.' });
    }

    const clickData = clickDoc.data();
    const userId = clickData.userId;
    const offerId = clickData.offerId;

    const normalizedPayout = parseFloat(payout) || 0;
    const userPoints = Math.floor(normalizedPayout * 10);

    const result = await db.runTransaction(async (t) => {
      const convSnap = await t.get(conversionRef);
      if (convSnap.exists) {
        return { duplicate: true };
      }

      const conversionPayload = {
        conversionId: conversion_id,
        network,
        clickId: click_id,
        userId,
        offerId,
        payoutReceived: normalizedPayout,
        pointsAwarded: userPoints,
        status: status === 'approved' ? 'APPROVED' : 'PENDING',
        rawPayload: req.body || req.query,
        processedAt: new Date().toISOString()
      };

      t.set(conversionRef, conversionPayload);
      return { duplicate: false, payload: conversionPayload };
    });

    if (result.duplicate) {
      return res.status(200).send('ACK_DUPLICATE');
    }

    if (result.payload.status === 'APPROVED' && userPoints > 0) {
      await WalletService.recordTransaction({
        userId,
        type: 'TASK_REWARD_APPROVED',
        amount: userPoints,
        direction: 'CREDIT',
        referenceId: conversion_id,
        description: `Offer payout conversion: ${offerId}`
      });
    }

    return res.status(200).send('ACK_PROCESSED');
  } catch (error) {
    console.error('Postback Processing Error:', error);
    return res.status(500).json({ error: 'Internal processing failure.' });
  }
};
