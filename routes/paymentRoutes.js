const express = require('express');
const router = express.Router();
const db = require('../config/db');
const protect = require('../middleware/authMiddleware');
const Razorpay = require('razorpay');
const { Cashfree, CFEnvironment } = require('cashfree-pg');

const getSettings = async () => {
  const [settings] = await db.query('SELECT * FROM system_settings');
  const settingsMap = {};
  settings.forEach(s => {
    settingsMap[s.key_name] = typeof s.key_value === 'string' ? s.key_value.trim() : s.key_value;
  });
  return settingsMap;
};

// Razorpay Order Creation
router.post('/razorpay/order', protect, async (req, res) => {
  const { amount, credits, packageId, streakchat_source, streakchat_order_id } = req.body;
  if (!amount || !credits) return res.status(400).json({ message: 'Amount and credits required' });

  try {
    const settings = await getSettings();
    const mode = settings.razorpay_mode || 'test';
    const key_id = settings.razorpay_key_id;
    const secret = settings.razorpay_secret;

    if (!key_id || !secret) {
      return res.status(400).json({ message: 'Razorpay is not configured by the admin yet' });
    }

    const instance = new Razorpay({
      key_id: key_id,
      key_secret: secret,
    });

    const rand5 = Math.floor(10000 + Math.random() * 90000);
    const rand4 = Math.floor(1000 + Math.random() * 9000);
    const orderIdStr = streakchat_order_id || `STC-RZP-${req.user.id}-${rand5}-C${packageId || '0'}-${rand4}`;

    const options = {
      amount: amount * 100,  // amount in the smallest currency unit
      currency: 'INR',
      receipt: orderIdStr,
      notes: {
        user_id: req.user.id.toString(),
        credits: credits.toString(),
        package_id: (packageId || '').toString(),
        streak_source: streakchat_source || '',
        streak_order: streakchat_order_id || ''
      }
    };

    const order = await instance.orders.create(options);

    // Save pending order to DB
    await db.query(
      'INSERT INTO payment_orders (order_id, user_id, package_id, amount, credits, gateway, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderIdStr, req.user.id, packageId || 0, amount, credits, 'razorpay', 'pending']
    );

    res.json(order);
  } catch (error) {
    console.error('Razorpay Order Error:', error);
    res.status(500).json({ message: 'Failed to create Razorpay order' });
  }
});

// Razorpay Verify
router.post('/razorpay/verify', protect, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, credits } = req.body;

  try {
    const settings = await getSettings();
    const secret = settings.razorpay_secret;
    const crypto = require('crypto');

    const expectedSignature = crypto.createHmac('sha256', secret)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      // Prevent double crediting by checking the payment_orders table
      const [existingOrder] = await db.query('SELECT status FROM payment_orders WHERE order_id = ?', [razorpay_order_id]);

      if (existingOrder.length > 0 && existingOrder[0].status === 'success') {
        const [updatedUser] = await db.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
        return res.json({ success: true, credits: updatedUser[0].credits, message: 'Already verified' });
      }

      // Payment verified, add credits
      await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [credits, req.user.id]);
      await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [razorpay_order_id]);
      await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
        req.user.id, credits, 'purchase', `Purchased via Razorpay (Order: ${razorpay_order_id})`
      ]);
      const [updatedUser] = await db.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
      res.json({ success: true, credits: updatedUser[0].credits });
    } else {
      res.status(400).json({ message: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Razorpay Verify Error:', error);
    res.status(500).json({ message: 'Failed to verify payment' });
  }
});

// Cashfree Order Creation
router.post('/cashfree/order', protect, async (req, res) => {
  const { amount, credits, packageId, streakchat_source, streakchat_order_id } = req.body;
  if (!amount || !credits) return res.status(400).json({ message: 'Amount and credits required' });

  try {
    const settings = await getSettings();
    const mode = settings.cashfree_mode || 'test';
    const appId = settings.cashfree_app_id;
    const secret = settings.cashfree_secret_key;

    if (!appId || !secret) {
      return res.status(400).json({ message: 'Cashfree is not configured by the admin yet' });
    }

    const cashfree = new Cashfree(
      mode === 'test' ? CFEnvironment.SANDBOX : CFEnvironment.PRODUCTION,
      appId,
      secret
    );

    const frontendUrl = process.env.NODE_ENV === 'production'
      ? process.env.PROD_FRONTEND_URL
      : process.env.DEV_FRONTEND_URL;

    const rand5 = Math.floor(10000 + Math.random() * 90000);
    const rand4 = Math.floor(1000 + Math.random() * 9000);
    const orderIdStr = streakchat_order_id || `STC-CFU-${req.user.id}-${rand5}-C${packageId || '0'}-${rand4}`;

    const request = {
      order_amount: amount,
      order_currency: 'INR',
      order_id: orderIdStr,
      customer_details: {
        customer_id: `cust_${req.user.id}`,
        customer_phone: "9999999999",
        customer_email: req.user.email || 'customer@example.com'
      },
      order_meta: {
        return_url: `${frontendUrl}/checkout?order_id={order_id}&gateway=cashfree&credits=${credits}`
      },
      order_tags: {
        user_id: req.user.id.toString(),
        credits: credits.toString(),
        package_id: (packageId || '').toString(),
        streak_source: streakchat_source || '',
        streak_order: streakchat_order_id || ''
      }
    };

    const response = await cashfree.PGCreateOrder(request);

    // Save pending order to DB
    await db.query(
      'INSERT INTO payment_orders (order_id, user_id, package_id, amount, credits, gateway, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderIdStr, req.user.id, packageId || 0, amount, credits, 'cashfree', 'pending']
    );

    res.json({ ...response.data, cf_mode: mode === 'test' ? 'sandbox' : 'production' });
  } catch (error) {
    console.error('Cashfree Order Error:', error);
    res.status(500).json({ message: 'Failed to create Cashfree order' });
  }
});

// Cashfree Verify
router.post('/cashfree/verify', protect, async (req, res) => {
  const { order_id, credits } = req.body;
  try {
    const settings = await getSettings();
    const mode = settings.cashfree_mode || 'test';
    const appId = settings.cashfree_app_id;
    const secret = settings.cashfree_secret_key;

    const cashfree = new Cashfree(
      mode === 'test' ? CFEnvironment.SANDBOX : CFEnvironment.PRODUCTION,
      appId,
      secret
    );

    const response = await cashfree.PGOrderFetchPayments(order_id);
    const payments = response.data;

    // Check if any payment is SUCCESS
    const successfulPayment = payments.find(p => p.payment_status === 'SUCCESS');

    if (successfulPayment) {
      // Prevent double crediting by checking the payment_orders table
      const [existingOrder] = await db.query('SELECT status FROM payment_orders WHERE order_id = ?', [order_id]);

      if (existingOrder.length > 0 && existingOrder[0].status === 'success') {
        const [updatedUser] = await db.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
        return res.json({ success: true, credits: updatedUser[0].credits, message: 'Already verified' });
      }

      // Payment verified, add credits
      await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [credits, req.user.id]);
      await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [order_id]);
      await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
        req.user.id, credits, 'purchase', `Purchased via Cashfree (Order: ${order_id})`
      ]);
      const [updatedUser] = await db.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
      res.json({ success: true, credits: updatedUser[0].credits });
    } else {
      res.status(400).json({ message: 'Payment not successful' });
    }
  } catch (error) {
    console.error('Cashfree Verify Error:', error);
    res.status(500).json({ message: 'Failed to verify Cashfree payment' });
  }
});

// Razorpay Webhook
router.post('/webhook/razorpay', async (req, res) => {
  try {

    const signature = req.headers['x-razorpay-signature'];
    const settings = await getSettings();
    const secret = settings.razorpay_webhook_secret;
    const crypto = require('crypto');


    const expectedSignature = crypto.createHmac('sha256', secret)
      .update(req.rawBody || JSON.stringify(req.body))
      .digest('hex');



    if (expectedSignature === signature) {
      if (req.body.event === 'payment.captured' || req.body.event === 'order.paid') {
        const paymentEntity = req.body.payload.payment ? req.body.payload.payment.entity : null;
        const orderEntity = req.body.payload.order ? req.body.payload.order.entity : null;
        const entity = paymentEntity || orderEntity;
        const notes = entity.notes || {};

        // Extract the custom string (STC-RZP-...) which Razorpay stores in the 'receipt' field of the order.
        // Fallback to Razorpay order ID if receipt is not available in the payload.
        const custom_order_id = orderEntity ? orderEntity.receipt : null;
        const rzp_order_id = paymentEntity ? paymentEntity.order_id : (orderEntity ? orderEntity.id : null);
        const search_order_id = custom_order_id || rzp_order_id;

        const credits = parseInt(notes.credits, 10);
        const user_id = notes.user_id;

        if (search_order_id && credits && user_id) {
          const [existingOrder] = await db.query('SELECT status FROM payment_orders WHERE order_id = ?', [search_order_id]);
          if (existingOrder.length > 0 && existingOrder[0].status === 'pending') {
            await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [search_order_id]);
            await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [credits, user_id]);
            await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
              user_id, credits, 'purchase', `Purchased via Razorpay (Order: ${search_order_id})`
            ]);

            // Cross domain callback
            const streak_source = notes.streak_source;
            const streak_order = notes.streak_order;
            const payment_id = req.body.payload.payment ? req.body.payload.payment.entity.id : order_id;

            if (streak_source && streak_order) {
              try {
                const cryptoHelper = require('../helpers/cryptoHelper');
                const cbPayload = { orderId: streak_order, transactionId: payment_id, status: "success" };
                const cbSig = cryptoHelper.generateSignature(cbPayload);
                const cbUrl = `https://${streak_source}.strictcheck.in/api/v1/payment/cross-domain-callback`;

                if (typeof fetch !== 'undefined') {
                  fetch(cbUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-cross-domain-signature': cbSig },
                    body: JSON.stringify(cbPayload)
                  }).then(r => r.json()).then(data => console.log('Cross domain callback response:', data)).catch(e => console.error('Cross domain fetch error:', e));
                }
              } catch (err) {
                console.error('Error triggering cross domain callback:', err);
              }
            }
          } else {
            console.log(`Razorpay Webhook: Order ${search_order_id} already processed or not found.`);
          }
        }
      } else if (req.body.event === 'payment.failed') {
        const paymentEntity = req.body.payload.payment ? req.body.payload.payment.entity : null;
        const orderEntity = req.body.payload.order ? req.body.payload.order.entity : null;
        const entity = paymentEntity || orderEntity;
        const notes = entity.notes || {};

        const custom_order_id = orderEntity ? orderEntity.receipt : null;
        const rzp_order_id = paymentEntity ? paymentEntity.order_id : (orderEntity ? orderEntity.id : null);
        const search_order_id = custom_order_id || rzp_order_id;

        if (search_order_id) {
          await db.query('UPDATE payment_orders SET status = "failed" WHERE order_id = ? AND status = "pending"', [search_order_id]);

          const streak_source = notes.streak_source;
          const streak_order = notes.streak_order;
          const payment_id = entity.id || rzp_order_id;

          if (streak_source && streak_order) {
            try {
              const cryptoHelper = require('../helpers/cryptoHelper');
              const cbPayload = { orderId: streak_order, transactionId: payment_id, status: "failed" };
              const cbSig = cryptoHelper.generateSignature(cbPayload);
              const cbUrl = `https://${streak_source}.strictcheck.in/api/v1/payment/cross-domain-callback`;

              if (typeof fetch !== 'undefined') {
                fetch(cbUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-cross-domain-signature': cbSig },
                  body: JSON.stringify(cbPayload)
                }).then(r => r.json()).then(data => console.log('Cross domain callback response:', data)).catch(e => console.error('Cross domain fetch error:', e));
              }
            } catch (err) {
              console.error('Error triggering cross domain callback:', err);
            }
          }
        }
      }
      res.status(200).json({ status: 'ok' });
    } else {
      res.status(400).json({ message: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Razorpay Webhook Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Cashfree Webhook
router.post('/webhook/cashfree', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const settings = await getSettings();
    const secret = settings.cashfree_secret_key;

    const crypto = require('crypto');
    const expectedSignature = crypto.createHmac('sha256', secret)
      .update(timestamp + (req.rawBody || JSON.stringify(req.body)))
      .digest('base64');

    if (expectedSignature !== signature) {
      return res.status(400).json({ message: 'Invalid signature' });
    }

    const payload = req.body;
    if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const order_id = payload.data.order.order_id;
      const order_tags = payload.data.order.order_tags || {};
      const credits = parseInt(order_tags.credits, 10);
      const user_id = order_tags.user_id;

      if (order_id && credits && user_id) {
        const [existingOrder] = await db.query('SELECT status FROM payment_orders WHERE order_id = ?', [order_id]);
        if (existingOrder.length > 0 && existingOrder[0].status === 'pending') {
          await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [order_id]);
          await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [credits, user_id]);
          await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
            user_id, credits, 'purchase', `Purchased via Cashfree (Order: ${order_id})`
          ]);

          // Cross domain callback
          const streak_source = order_tags.streak_source;
          const streak_order = order_tags.streak_order;
          const payment_id = (payload.data.payment && payload.data.payment.cf_payment_id) ? payload.data.payment.cf_payment_id.toString() : order_id;

          if (streak_source && streak_order) {
            try {
              const cryptoHelper = require('../helpers/cryptoHelper');
              const cbPayload = { orderId: streak_order, transactionId: payment_id, status: "success" };
              const cbSig = cryptoHelper.generateSignature(cbPayload);
              const cbUrl = `https://${streak_source}.strictcheck.in/api/v1/payment/cross-domain-callback`;

              if (typeof fetch !== 'undefined') {
                fetch(cbUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-cross-domain-signature': cbSig },
                  body: JSON.stringify(cbPayload)
                }).then(r => r.json()).then(data => console.log('Cross domain callback response:', data)).catch(e => console.error('Cross domain fetch error:', e));
              }
            } catch (err) {
              console.error('Error triggering cross domain callback:', err);
            }
          }
        } else {
          console.log(`Cashfree Webhook: Order ${order_id} already processed or not found.`);
        }
      }
    } else if (payload.type === 'PAYMENT_FAILED_WEBHOOK' || payload.type === 'PAYMENT_USER_DROPPED_WEBHOOK') {
      const order_id = payload.data.order.order_id;
      const order_tags = payload.data.order.order_tags || {};

      if (order_id) {
        await db.query('UPDATE payment_orders SET status = "failed" WHERE order_id = ? AND status = "pending"', [order_id]);

        const streak_source = order_tags.streak_source;
        const streak_order = order_tags.streak_order;
        const payment_id = (payload.data.payment && payload.data.payment.cf_payment_id) ? payload.data.payment.cf_payment_id.toString() : order_id;

        if (streak_source && streak_order) {
          try {
            const cryptoHelper = require('../helpers/cryptoHelper');
            const cbPayload = { orderId: streak_order, transactionId: payment_id, status: "failed" };
            const cbSig = cryptoHelper.generateSignature(cbPayload);
            const cbUrl = `https://${streak_source}.strictcheck.in/api/v1/payment/cross-domain-callback`;

            if (typeof fetch !== 'undefined') {
              fetch(cbUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-cross-domain-signature': cbSig },
                body: JSON.stringify(cbPayload)
              }).then(r => r.json()).then(data => console.log('Cross domain callback response:', data)).catch(e => console.error('Cross domain fetch error:', e));
            }
          } catch (err) {
            console.error('Error triggering cross domain callback:', err);
          }
        }
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Cashfree Webhook Error:', error.message);
    res.status(400).json({ message: 'Invalid signature or error processing' });
  }
});

// Helper for cross-domain Streakchat callback
const triggerCrossDomainCallback = (streak_source, streak_order, transaction_id, status) => {
  if (!streak_source || !streak_order) return;
  try {
    const cryptoHelper = require('../helpers/cryptoHelper');
    const cbPayload = { orderId: streak_order, transactionId: transaction_id || streak_order, status };
    const cbSig = cryptoHelper.generateSignature(cbPayload);
    const cbUrl = `https://${streak_source}.strictcheck.in/api/v1/payment/cross-domain-callback`;

    if (typeof fetch !== 'undefined') {
      fetch(cbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cross-domain-signature': cbSig },
        body: JSON.stringify(cbPayload)
      })
        .then(r => r.json())
        .then(data => console.log('Cross domain callback response:', data))
        .catch(e => console.error('Cross domain fetch error:', e));
    }
  } catch (err) {
    console.error('Error triggering cross domain callback:', err);
  }
};

// ==========================================
// PHONEPE INTEGRATION
// ==========================================

// PhonePe Order Creation
router.post('/phonepe/order', protect, async (req, res) => {
  const { amount, credits, packageId, streakchat_source, streakchat_order_id } = req.body;
  if (!amount || !credits) return res.status(400).json({ message: 'Amount and credits required' });

  try {
    const settings = await getSettings();
    const mode = settings.phonepe_mode || 'test';
    const clientId = settings.phonepe_client_id;
    const clientSecret = settings.phonepe_client_secret;

    if (!clientId || !clientSecret) {
      return res.status(400).json({ message: 'PhonePe is not configured by the admin yet' });
    }

    const rand5 = Math.floor(10000 + Math.random() * 90000);
    const rand4 = Math.floor(1000 + Math.random() * 9000);
    const orderIdStr = streakchat_order_id || `STC-PHN-${req.user.id}-${rand5}-C${packageId || '0'}-${rand4}`;

    // Save pending order to DB
    await db.query(
      'INSERT INTO payment_orders (order_id, user_id, package_id, amount, credits, gateway, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderIdStr, req.user.id, packageId || 0, amount, credits, 'phonepe', 'pending']
    );

    const frontendUrl = process.env.NODE_ENV === 'production'
      ? process.env.PROD_FRONTEND_URL
      : process.env.DEV_FRONTEND_URL;

    const backendUrl = process.env.NODE_ENV === 'production'
      ? (process.env.PROD_FRONTEND_URL || 'https://strictcheck.in')
      : (process.env.DEV_FRONTEND_URL ? process.env.DEV_FRONTEND_URL.replace('5173', '5000') : 'http://localhost:5000');

    const saltKey = clientSecret.includes('###') ? clientSecret.split('###')[0] : clientSecret;
    const saltIndex = clientSecret.includes('###') ? clientSecret.split('###')[1] : '1';
    const amountInPaise = Math.round(Number(amount) * 100);

    const normalPayload = {
      merchantId: clientId,
      merchantTransactionId: orderIdStr,
      merchantUserId: `MUID_${req.user.id}`,
      amount: amountInPaise,
      redirectUrl: `${frontendUrl}/checkout?order_id=${orderIdStr}&gateway=phonepe&credits=${credits}`,
      redirectMode: 'REDIRECT',
      callbackUrl: `${backendUrl}/api/payments/webhook/phonepe`,
      mobileNumber: "9999999999",
      paymentInstrument: {
        type: "PAY_PAGE"
      }
    };

    const bufferObj = Buffer.from(JSON.stringify(normalPayload), "utf8");
    const base64String = bufferObj.toString("base64");
    const crypto = require('crypto');
    const mainString = base64String + "/pg/v1/pay" + saltKey;
    const sha256Val = crypto.createHash('sha256').update(mainString).digest('hex');
    const checkSum = `${sha256Val}###${saltIndex}`;

    const host = mode === 'live' ? 'https://api.phonepe.com/apis/hermes' : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

    if (typeof fetch !== 'undefined') {
      let apiRes = await fetch(`${host}/pg/v1/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checkSum,
          'accept': 'application/json'
        },
        body: JSON.stringify({ request: base64String })
      });

      // If preprod returned 404 on pg-sandbox, fallback to hermes
      if (!apiRes.ok && mode !== 'live') {
        try {
          const fallbackRes = await fetch(`https://api-preprod.phonepe.com/apis/hermes/pg/v1/pay`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-VERIFY': checkSum,
              'accept': 'application/json'
            },
            body: JSON.stringify({ request: base64String })
          });
          if (fallbackRes.ok) {
            apiRes = fallbackRes;
          }
        } catch (e) {}
      }

      const resText = await apiRes.text();
      let responseData;
      try {
        responseData = JSON.parse(resText);
      } catch (e) {
        console.error('PhonePe Pay API non-JSON response:', resText);
        return res.status(400).json({
          message: 'PhonePe API returned an invalid response. Please verify your PhonePe Client ID and Secret in Admin Settings.'
        });
      }

      if (responseData.success && responseData.data?.instrumentResponse?.redirectInfo?.url) {
        return res.json({
          redirectUrl: responseData.data.instrumentResponse.redirectInfo.url,
          order_id: orderIdStr
        });
      } else {
        console.error('PhonePe Pay API error:', responseData);
        return res.status(400).json({
          message: responseData.message || 'PhonePe payment initialization failed. Please check credentials.'
        });
      }
    } else {
      res.status(500).json({ message: 'Server environment lacks fetch API' });
    }
  } catch (error) {
    console.error('PhonePe Order Error:', error);
    res.status(500).json({ message: error.message || 'Failed to create PhonePe order' });
  }
});

// PhonePe Verify
router.post('/phonepe/verify', protect, async (req, res) => {
  const { order_id, credits, streakchat_source, streakchat_order_id } = req.body;
  try {
    const settings = await getSettings();
    const mode = settings.phonepe_mode || 'test';
    const clientId = settings.phonepe_client_id;
    const clientSecret = settings.phonepe_client_secret;

    const [existingOrder] = await db.query('SELECT status FROM payment_orders WHERE order_id = ?', [order_id]);
    if (existingOrder.length > 0 && existingOrder[0].status === 'success') {
      const [updatedUser] = await db.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
      return res.json({ success: true, credits: updatedUser[0].credits, message: 'Already verified' });
    }

    const saltKey = clientSecret.includes('###') ? clientSecret.split('###')[0] : clientSecret;
    const saltIndex = clientSecret.includes('###') ? clientSecret.split('###')[1] : '1';
    const crypto = require('crypto');
    const endpoint = `/pg/v1/status/${clientId}/${order_id}`;
    const stringToHash = endpoint + saltKey;
    const sha256Val = crypto.createHash('sha256').update(stringToHash).digest('hex');
    const checkSum = `${sha256Val}###${saltIndex}`;

    const host = mode === 'live' ? 'https://api.phonepe.com/apis/hermes' : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

    let isSuccess = false;
    if (typeof fetch !== 'undefined') {
      try {
        const statusRes = await fetch(`${host}${endpoint}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': checkSum,
            'X-MERCHANT-ID': clientId
          }
        });
        const statusData = await statusRes.json();
        if (statusData.code === 'PAYMENT_SUCCESS') {
          isSuccess = true;
        }
      } catch (e) {
        console.error('PhonePe Check Status API fetch error:', e);
      }
    }

    if (isSuccess) {
      await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [credits, req.user.id]);
      await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [order_id]);
      await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
        req.user.id, credits, 'purchase', `Purchased via PhonePe (Order: ${order_id})`
      ]);

      if (streakchat_source && streakchat_order_id) {
        triggerCrossDomainCallback(streakchat_source, streakchat_order_id, order_id, 'success');
      }

      const [updatedUser] = await db.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
      res.json({ success: true, credits: updatedUser[0].credits });
    } else {
      res.status(400).json({ message: 'PhonePe payment was not successful' });
    }
  } catch (error) {
    console.error('PhonePe Verify Error:', error);
    res.status(500).json({ message: 'Failed to verify PhonePe payment' });
  }
});

// PhonePe Webhook
router.post('/webhook/phonepe', async (req, res) => {
  try {
    const settings = await getSettings();
    const webhookUsername = settings.phonepe_webhook_username;
    const webhookPassword = settings.phonepe_webhook_password;

    if (webhookUsername && webhookPassword) {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Basic ')) {
        const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
        const [u, p] = credentials.split(':');
        if (u !== webhookUsername || p !== webhookPassword) {
          return res.status(401).json({ message: 'Unauthorized webhook request' });
        }
      }
    }

    const body = req.body;
    let payload = body;
    if (body.response) {
      try {
        const decoded = Buffer.from(body.response, 'base64').toString('utf8');
        payload = JSON.parse(decoded);
      } catch (e) {}
    }

    if (payload.code === 'PAYMENT_SUCCESS' && payload.data) {
      const order_id = payload.data.merchantTransactionId;
      const [orderRows] = await db.query('SELECT * FROM payment_orders WHERE order_id = ?', [order_id]);
      if (orderRows.length > 0 && orderRows[0].status === 'pending') {
        const order = orderRows[0];
        await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [order_id]);
        await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [order.credits, order.user_id]);
        await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
          order.user_id, order.credits, 'purchase', `Purchased via PhonePe (Order: ${order_id})`
        ]);
      }
    }
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('PhonePe Webhook Error:', error.message);
    res.status(500).json({ message: 'Error processing PhonePe webhook' });
  }
});

// ==========================================
// PAYU INTEGRATION
// ==========================================

// PayU Order Creation
router.post('/payu/order', protect, async (req, res) => {
  const { amount, credits, packageId, streakchat_source, streakchat_order_id } = req.body;
  if (!amount || !credits) return res.status(400).json({ message: 'Amount and credits required' });

  try {
    const settings = await getSettings();
    const mode = settings.payu_mode || 'test';
    const key = settings.payu_merchant_key;
    const salt = settings.payu_merchant_salt;

    if (!key || !salt) {
      return res.status(400).json({ message: 'PayU is not configured by the admin yet' });
    }

    const rand5 = Math.floor(10000 + Math.random() * 90000);
    const rand4 = Math.floor(1000 + Math.random() * 9000);
    const orderIdStr = streakchat_order_id || `STC-PYU-${req.user.id}-${rand5}-C${packageId || '0'}-${rand4}`;

    // Save pending order to DB
    await db.query(
      'INSERT INTO payment_orders (order_id, user_id, package_id, amount, credits, gateway, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderIdStr, req.user.id, packageId || 0, amount, credits, 'payu', 'pending']
    );

    const backendUrl = process.env.NODE_ENV === 'production'
      ? (process.env.PROD_FRONTEND_URL || 'https://strictcheck.in')
      : (process.env.DEV_FRONTEND_URL ? process.env.DEV_FRONTEND_URL.replace('5173', '5000') : 'http://localhost:5000');

    const formattedAmount = Number(amount).toFixed(2);
    const productInfo = `StrictCheck_${credits}_Tokens`;
    const firstName = req.user.name || 'User';
    const email = req.user.email || 'customer@example.com';
    const phone = "9999999999";
    const udf1 = req.user.id.toString();
    const udf2 = credits.toString();
    const udf3 = (packageId || 0).toString();
    const udf4 = streakchat_source || '';
    const udf5 = streakchat_order_id || '';

    const surl = `${backendUrl}/api/payments/payu/response`;
    const furl = `${backendUrl}/api/payments/payu/response`;

    // PayU Hash formula: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
    const crypto = require('crypto');
    const hashString = `${key}|${orderIdStr}|${formattedAmount}|${productInfo}|${firstName}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`;
    const hash = crypto.createHash('sha512').update(hashString).digest('hex');

    const action = mode === 'live' ? 'https://secure.payu.in/_payment' : 'https://test.payu.in/_payment';

    res.json({
      action,
      params: {
        key,
        txnid: orderIdStr,
        amount: formattedAmount,
        productinfo: productInfo,
        firstname: firstName,
        email,
        phone,
        surl,
        furl,
        hash,
        udf1,
        udf2,
        udf3,
        udf4,
        udf5
      }
    });
  } catch (error) {
    console.error('PayU Order Error:', error);
    res.status(500).json({ message: 'Failed to create PayU order' });
  }
});

// PayU Response (SURL & FURL handler from PayU Hosted Checkout redirect)
router.post('/payu/response', async (req, res) => {
  try {
    const { status, txnid, udf1, udf2, udf4, udf5 } = req.body;

    const frontendUrl = process.env.NODE_ENV === 'production'
      ? process.env.PROD_FRONTEND_URL
      : process.env.DEV_FRONTEND_URL;

    const user_id = udf1;
    const credits = parseInt(udf2 || '0', 10);
    const streak_source = udf4;
    const streak_order = udf5;

    if (status === 'success') {
      const [existingOrder] = await db.query('SELECT status FROM payment_orders WHERE order_id = ?', [txnid]);
      if (existingOrder.length > 0 && existingOrder[0].status === 'pending') {
        await db.query('UPDATE payment_orders SET status = "success" WHERE order_id = ?', [txnid]);
        await db.query('UPDATE users SET credits = credits + ? WHERE id = ?', [credits, user_id]);
        await db.query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [
          user_id, credits, 'purchase', `Purchased via PayU (Order: ${txnid})`
        ]);

        if (streak_source && streak_order) {
          triggerCrossDomainCallback(streak_source, streak_order, txnid, 'success');
        }
      }
      return res.redirect(`${frontendUrl}/checkout?order_id=${txnid}&gateway=payu&status=success&credits=${credits}`);
    } else {
      await db.query('UPDATE payment_orders SET status = "failed" WHERE order_id = ? AND status = "pending"', [txnid]);
      if (streak_source && streak_order) {
        triggerCrossDomainCallback(streak_source, streak_order, txnid, 'failed');
      }
      return res.redirect(`${frontendUrl}/checkout?order_id=${txnid}&gateway=payu&status=failed`);
    }
  } catch (error) {
    console.error('PayU Response Error:', error);
    res.status(500).send('Error processing payment response');
  }
});

module.exports = router;
