const { db } = require('../config/firebase');
const WalletService = require('./walletService');

class StreakService {
  static async claimDailyCheckIn(userId) {
    const istDateString = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    const streakRef = db.collection('daily_checkins').doc(userId);

    return await db.runTransaction(async (t) => {
      const snap = await t.get(streakRef);
      let currentStreak = 0;
      let lastClaimDate = null;

      if (snap.exists) {
        const data = snap.data();
        lastClaimDate = data.lastClaimDate;
        currentStreak = data.currentStreak || 0;
      }

      if (lastClaimDate === istDateString) {
        throw new Error('Already claimed today. Check back tomorrow at midnight IST.');
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(yesterday);

      if (lastClaimDate === yesterdayStr) {
        currentStreak += 1;
      } else {
        currentStreak = 1;
      }

      const rewardPoints = currentStreak === 7 ? 50 : 10;

      t.set(streakRef, {
        userId,
        currentStreak,
        lastClaimDate: istDateString,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      await WalletService.recordTransaction({
        userId,
        type: 'DAILY_CHECKIN',
        amount: rewardPoints,
        direction: 'CREDIT',
        referenceId: `CHECKIN_${istDateString}`,
        description: `Daily check-in Day ${currentStreak} bonus`
      });

      return {
        claimed: true,
        currentStreak,
        rewardPoints,
        date: istDateString
      };
    });
  }
}

module.exports = StreakService;
