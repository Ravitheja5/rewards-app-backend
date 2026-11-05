const { db } = require('../config/firebase');
const crypto = require('crypto');

class WalletService {
  static async recordTransaction({
    userId,
    type,
    amount,
    direction,
    referenceId,
    description,
    idempotencyKey
  }) {
    if (!userId || !amount || amount <= 0 || !['CREDIT', 'DEBIT'].includes(direction)) {
      throw new Error('Invalid transaction parameters.');
    }

    const key = idempotencyKey || crypto.createHash('sha256').update(`${userId}-${type}-${referenceId}-${direction}`).digest('hex');
    const txRef = db.collection('wallet_transactions').doc(key);
    const walletRef = db.collection('wallets').doc(userId);

    return await db.runTransaction(async (t) => {
      const existingTx = await t.get(txRef);
      if (existingTx.exists) {
        return { status: 'DUPLICATE_IGNORED', transaction: existingTx.data() };
      }

      const walletDoc = await t.get(walletRef);
      let availablePoints = 0;
      let lifetimeEarned = 0;
      let totalRedeemed = 0;

      if (walletDoc.exists) {
        const data = walletDoc.data();
        availablePoints = Number(data.availablePoints) || 0;
        lifetimeEarned = Number(data.lifetimeEarned) || 0;
        totalRedeemed = Number(data.totalRedeemed) || 0;
      }

      if (direction === 'DEBIT' && availablePoints < amount) {
        throw new Error('Insufficient points balance.');
      }

      let newAvailable = availablePoints;
      let newLifetime = lifetimeEarned;
      let newRedeemed = totalRedeemed;

      if (direction === 'CREDIT') {
        newAvailable += amount;
        newLifetime += amount;
      } else {
        newAvailable -= amount;
        newRedeemed += amount;
      }

      const txRecord = {
        txId: key,
        userId,
        type,
        amount,
        direction,
        referenceId: referenceId || null,
        description: description || '',
        createdAt: new Date().toISOString(),
        balanceAfter: newAvailable
      };

      t.set(txRef, txRecord);
      t.set(walletRef, {
        userId,
        availablePoints: newAvailable,
        lifetimeEarned: newLifetime,
        totalRedeemed: newRedeemed,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      return { status: 'COMMITTED', transaction: txRecord };
    });
  }

  static async getBalance(userId) {
    const doc = await db.collection('wallets').doc(userId).get();
    if (!doc.exists) {
      return { availablePoints: 0, pendingPoints: 0, lifetimeEarned: 0, totalRedeemed: 0 };
    }
    return doc.data();
  }
}

module.exports = WalletService;
