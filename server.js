// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const multer = require('multer');
const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { DateTime } = require('luxon');

dotenv.config({ path: path.resolve(__dirname, 'variables.env') });

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !DATABASE_URL || !WHATSAPP_VERIFY_TOKEN) {
  console.error("❌ Missing essential environment variables. Check variables.env!");
  process.exit(1);
}

// --- PostgreSQL connection ---
const pool = new Pool({ connectionString: DATABASE_URL });
pool.connect()
  .then(client => {
    console.log('✅ Connected to Postgres database successfully.');
    client.release();
  })
  .catch(err => {
    console.error('❌ Failed to connect to Postgres database:', err.message);
    process.exit(1);
  });

// --- Express app ---
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Multer setup for file uploads ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

// --- WhatsApp allowed MIME types ---
const WHATSAPP_ALLOWED_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/3gpp'],
  audio: ['audio/aac','audio/mp4','audio/mpeg','audio/amr','audio/ogg','audio/opus'],
  document: ['application/pdf','application/vnd.ms-powerpoint','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain','application/vnd.ms-excel']
};

// --- Create tables if not exists ---
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_library (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      content BYTEA NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id SERIAL PRIMARY KEY,
      phone_number TEXT NOT NULL,
      message_text TEXT,
      media_id INT REFERENCES media_library(id),
      scheduled_time TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'pending'
    )`);
  console.log('✅ Tables verified/created.');
}
createTables().catch(err => console.error('❌ Error creating tables:', err));

// --- Admin route ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- Upload media ---
app.post('/api/upload-media', upload.single('mediaFile'), async (req, res) => {
  try {
    const file = req.file;
    const name = req.body.name;
    if (!file || !name) return res.json({ success: false, error: 'Missing file or name' });

    const type = file.mimetype;
    const allowed = Object.values(WHATSAPP_ALLOWED_TYPES).flat();
    if (!allowed.includes(type)) return res.json({ success: false, error: `Unsupported file type: ${type}` });

    await pool.query(
      "INSERT INTO media_library(name,type,content) VALUES($1,$2,$3)",
      [name, type, file.buffer]
    );

    console.log(`📁 Media uploaded: ${name} (${type})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Upload media error:', err);
    res.json({ success: false, error: err.message });
  }
});

// --- Get media library ---
app.get('/api/media-library', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, type, encode(content,'base64') AS base64 FROM media_library ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get media library error:', err);
    res.json([]);
  }
});

// --- WhatsApp helper functions ---
async function uploadMediaToWhatsApp(name, type, buffer) {
  try {
    const formData = new FormData();
    formData.append('file', buffer, { filename: name, contentType: type });
    formData.append('messaging_product', 'whatsapp');

    const response = await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/media`,
      formData,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...formData.getHeaders() } }
    );
    return response.data.id;
  } catch (err) {
    console.error('❌ WhatsApp media upload error:', err.response?.data || err.message);
    return null;
  }
}

function getWhatsAppPayloadType(mimeType) {
  for (const [type, list] of Object.entries(WHATSAPP_ALLOWED_TYPES)) {
    if (list.includes(mimeType)) return type;
  }
  return 'document';
}

async function sendWhatsAppMessage(to, text, mediaRow = null) {
  const payload = { messaging_product: 'whatsapp', to };

  try {
    if (mediaRow) {
      const mediaId = await uploadMediaToWhatsApp(mediaRow.name, mediaRow.type, mediaRow.content);
      if (!mediaId) throw new Error('Media upload failed');

      const waType = getWhatsAppPayloadType(mediaRow.type);
      payload.type = waType;
      payload[waType] = { id: mediaId, caption: text || "" };
    } else {
      payload.type = 'text';
      payload.text = { body: text };
    }

    const resp = await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log('📩 WhatsApp API response:', JSON.stringify(resp.data, null, 2));
    return resp.data.messages?.[0]?.id || null;
  } catch (err) {
    console.error('❌ Send WhatsApp message error:', err.response?.data || err.message);
    return null;
  }
}

// --- Schedule message ---
app.post('/api/schedule-message', async (req, res) => {
  try {
    const { phone_number, message_text, media_id, scheduled_time } = req.body;
    if (!phone_number || !scheduled_time) return res.json({ success: false, error: 'Missing required fields' });

    const scheduledUTC = DateTime.fromISO(scheduled_time, { zone: 'Asia/Kolkata' }).toUTC().toISO();

    const result = await pool.query(
      "INSERT INTO scheduled_messages(phone_number,message_text,media_id,scheduled_time,status) VALUES($1,$2,$3,$4,'pending') RETURNING *",
      [phone_number, message_text, media_id || null, scheduledUTC]
    );

    console.log(`🗓 Scheduled message ID ${result.rows[0].id} for ${phone_number} at ${scheduled_time} IST`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('❌ Schedule message error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// --- Get scheduled messages ---
app.get('/api/scheduled-messages', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sm.*, m.name AS media_name, encode(m.content,'base64') AS media_base64, m.type AS media_type
      FROM scheduled_messages sm
      LEFT JOIN media_library m ON sm.media_id = m.id
      ORDER BY scheduled_time DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get scheduled messages error:', err.message);
    res.json([]);
  }
});

// --- Process pending messages (for cron) ---
async function processDueMessages() {
  try {
    const nowUTC = DateTime.now().toUTC().toISO();
    const pending = await pool.query(
      "SELECT * FROM scheduled_messages WHERE status='pending' AND scheduled_time <= $1",
      [nowUTC]
    );

    for (const msg of pending.rows) {
      try {
        const mediaRow = msg.media_id
          ? await pool.query("SELECT * FROM media_library WHERE id=$1", [msg.media_id]).then(r => r.rows[0])
          : null;

        const messageId = await sendWhatsAppMessage(msg.phone_number, msg.message_text, mediaRow);

        await pool.query(
          "UPDATE scheduled_messages SET status=$1 WHERE id=$2",
          [messageId ? 'sent' : 'failed', msg.id]
        );
        console.log(`📤 Processed scheduled message ID ${msg.id}`);
      } catch (err) {
        console.error(`❌ Error processing scheduled message ID ${msg.id}:`, err.message);
        await pool.query("UPDATE scheduled_messages SET status='failed' WHERE id=$1", [msg.id]);
      }
    }
  } catch (err) {
    console.error("❌ processDueMessages error:", err.message);
  }
}

app.get('/api/check-pending', async (req, res) => {
  await processDueMessages();
  res.json({ success: true });
});

// --- Webhook verification ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.warn('❌ Webhook verification failed');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// --- Webhook POST endpoint ---
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook received:', JSON.stringify(req.body, null, 2));

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const statuses = change.value.statuses || [];
        for (const status of statuses) {
          const messageId = status.id;
          const messageStatus = status.status; // sent, delivered, read, failed

          console.log(`Message ${messageId} status: ${messageStatus}`);

          // Update DB using the WhatsApp message ID
          await pool.query(
            "UPDATE scheduled_messages SET status=$1 WHERE id=$2",
            [messageStatus === 'delivered' || messageStatus === 'read' ? 'sent' : 'failed', messageId]
          );
        }
      }
    }
  } catch (err) {
    console.error('❌ Error processing webhook:', err.message);
  }

  res.sendStatus(200);
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💻 Admin panel: http://localhost:${PORT}/admin`);
});
