require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

const dbPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.DATABASE_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
    })
  : null;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function requireLogin(req, res, next) {
  if (req.session && req.session.isAdminLoggedIn) {
    return next();
  }

  return res.redirect('/login');
}

async function initializeDatabase() {
  if (!dbPool) {
    console.log('DATABASE_URL is missing. Database saving disabled.');
    return;
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS attendance_reports (
      id SERIAL PRIMARY KEY,
      public_id TEXT UNIQUE NOT NULL,
      report_date TEXT NOT NULL,
      report_date_short TEXT,
      session_name TEXT NOT NULL,
      zoom_meeting_id TEXT,
      zoom_uuid TEXT,
      topic TEXT,
      start_time TEXT,
      end_time TEXT,
      timezone TEXT,
      participant_count INTEGER DEFAULT 0,
      time_wise_report TEXT,
      name_wise_report TEXT,
      final_report TEXT NOT NULL,
      whatsapp_sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id SERIAL PRIMARY KEY,
      report_public_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      join_time TEXT,
      duration_minutes INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('Database initialized successfully');
}

function generatePublicReportId() {
  return crypto.randomBytes(12).toString('hex');
}

async function saveAttendanceReport({
  config,
  meetingId,
  meetingUuid,
  topic,
  participantRows,
  timeWiseReport,
  nameWiseReport,
  finalReport,
  whatsappSent,
}) {
  if (!dbPool) {
    console.log('DATABASE_URL is missing. Skipping report save.');
    return null;
  }

  const publicId = generatePublicReportId();
  
  const existingReport = await dbPool.query(
  `
    SELECT public_id
    FROM attendance_reports
    WHERE zoom_uuid = $1
    LIMIT 1;
  `,
  [meetingUuid]
);

if (existingReport.rows.length > 0) {
  console.log('Report already exists for this Zoom UUID. Skipping duplicate save.');
  return existingReport.rows[0];
}

  const result = await dbPool.query(
    `
      INSERT INTO attendance_reports (
        public_id,
        report_date,
        report_date_short,
        session_name,
        zoom_meeting_id,
        zoom_uuid,
        topic,
        start_time,
        end_time,
        timezone,
        participant_count,
        time_wise_report,
        name_wise_report,
        final_report,
        whatsapp_sent
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15
      )
      RETURNING id, public_id;
    `,
    [
      publicId,
      config.reportDate,
      config.reportDateShort,
      config.sessionName,
      meetingId,
      meetingUuid,
      topic,
      config.startTime,
      config.endTime,
      config.timezone,
      participantRows.length,
      timeWiseReport,
      nameWiseReport,
      finalReport,
      whatsappSent,
    ]
  );

  for (const row of participantRows) {
    await dbPool.query(
      `
        INSERT INTO attendance_records (
          report_public_id,
          participant_name,
          join_time,
          duration_minutes
        )
        VALUES ($1, $2, $3, $4);
      `,
      [
        publicId,
        row.name,
        row.firstJoinTime.toFormat('HH:mm'),
        row.totalDurationMinutes,
      ]
    );
  }

  return result.rows[0];
}

async function getZoomAccessToken() {
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    null,
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    }
  );

  return response.data.access_token;
}

function encodeMeetingUuid(uuid) {
  let encoded = encodeURIComponent(uuid);

  if (uuid.startsWith('/') || uuid.includes('//')) {
    encoded = encodeURIComponent(encoded);
  }

  return encoded;
}

async function getMeetingParticipants(meetingUuid) {
  const token = await getZoomAccessToken();
  const encodedMeetingUuid = encodeMeetingUuid(meetingUuid);

  const allParticipants = [];
  let nextPageToken = '';

  do {
    const response = await axios.get(
      `https://api.zoom.us/v2/report/meetings/${encodedMeetingUuid}/participants`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          page_size: 300,
          next_page_token: nextPageToken || undefined,
        },
      }
    );

    allParticipants.push(...(response.data.participants || []));
    nextPageToken = response.data.next_page_token || '';
  } while (nextPageToken);

  return allParticipants;
}

async function getZoomMeetingsForDate(dateIso) {
  const token = await getZoomAccessToken();
  const zoomUserId = process.env.ZOOM_REPORT_USER_ID;

  if (!zoomUserId) {
    throw new Error('ZOOM_REPORT_USER_ID is missing');
  }

  const encodedUserId = encodeURIComponent(zoomUserId);

  const allMeetings = [];
  let nextPageToken = '';

  do {
    const response = await axios.get(
      `https://api.zoom.us/v2/report/users/${encodedUserId}/meetings`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          from: dateIso,
          to: dateIso,
          page_size: 300,
          next_page_token: nextPageToken || undefined,
        },
      }
    );

    allMeetings.push(...(response.data.meetings || []));
    nextPageToken = response.data.next_page_token || '';
  } while (nextPageToken);

  return allMeetings;
}

function normalizeMeetingForReport(meeting) {
  if (meeting.end_time) {
    return meeting;
  }

  const startTime = DateTime.fromISO(meeting.start_time, {
    zone: 'utc',
  });

  const durationMinutes = Number(meeting.duration || 0);

  return {
    ...meeting,
    end_time: startTime
      .plus({ minutes: durationMinutes })
      .toUTC()
      .toISO({ suppressMilliseconds: true }),
  };
}

function encodeMeetingForForm(meeting) {
  return Buffer.from(JSON.stringify(meeting), 'utf8').toString('base64');
}

function decodeMeetingFromForm(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function getMeetingDropdownLabel(meeting, timezone) {
  const startTime = meeting.start_time
    ? DateTime.fromISO(meeting.start_time, { zone: 'utc' })
        .setZone(timezone)
        .toFormat('HH:mm')
    : 'Unknown';

  const topic = meeting.topic || 'Untitled meeting';
  const meetingId = String(meeting.id || '').replace(/\s/g, '');
  const duration = meeting.duration ? `${meeting.duration} mins` : 'duration unknown';

  return `${startTime} - ${topic} - ${meetingId} - ${duration}`;
}


function roundUpToNextInterval(dateTime, intervalMinutes) {
  const minute = dateTime.minute;
  const remainder = minute % intervalMinutes;

  let rounded = dateTime.set({
    second: 0,
    millisecond: 0,
  });

  if (remainder === 0 && dateTime.second === 0) {
    return rounded;
  }

  return rounded.plus({ minutes: intervalMinutes - remainder });
}

function getDynamicReportTimeRange(meeting, timezone, intervalMinutes) {
  const meetingStart = DateTime.fromISO(meeting.start_time, {
    zone: 'utc',
  }).setZone(timezone);

  const meetingEnd = DateTime.fromISO(meeting.end_time, {
    zone: 'utc',
  }).setZone(timezone);

  const reportStart = roundUpToNextInterval(meetingStart, intervalMinutes);
  const reportEnd = roundUpToNextInterval(meetingEnd, intervalMinutes);

  return {
    reportDate: meetingStart.toFormat('dd/MM/yyyy'),
    reportDateShort: meetingStart.toFormat('dd/MM/yy'),
    startTime: reportStart.toFormat('HH:mm'),
    endTime: reportEnd.toFormat('HH:mm'),
  };
}

function formatDisplayTime(dateTime) {
  const hour = dateTime.hour;
  const minute = String(dateTime.minute).padStart(2, '0');

  const suffix = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;

  return `${hour12}.${minute}${suffix}`;
}

function getParticipantDisplayName(participant) {
  return (
    participant.name ||
    participant.user_name ||
    participant.email ||
    'Unknown'
  ).trim();
}

function getParticipantKey(participant) {
  return getParticipantDisplayName(participant)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getMergedParticipantRows(participants, timezone) {
  const uniqueMap = new Map();

  for (const participant of participants) {
    if (!participant.join_time) {
      continue;
    }

    const name = getParticipantDisplayName(participant);
    const participantKey = getParticipantKey(participant);

    const joinTime = DateTime.fromISO(participant.join_time, {
      zone: 'utc',
    }).setZone(timezone);

    const durationSeconds = participant.duration || 0;
    const durationMinutes = Math.round(durationSeconds / 60);

    const existing = uniqueMap.get(participantKey);

    if (!existing) {
      uniqueMap.set(participantKey, {
        name,
        firstJoinTime: joinTime,
        totalDurationMinutes: durationMinutes,
      });
    } else {
      if (joinTime < existing.firstJoinTime) {
        existing.firstJoinTime = joinTime;
      }

      existing.totalDurationMinutes += durationMinutes;
    }
  }

  return Array.from(uniqueMap.values())
    .sort((a, b) => a.firstJoinTime.toMillis() - b.firstJoinTime.toMillis());
}

function countParticipantsJoinedUntil(participants, slotDateTime, intervalMinutes, timezone) {
  const uniqueParticipants = new Set();
  const slotEndTime = slotDateTime.plus({ minutes: intervalMinutes });

  for (const participant of participants) {
    if (!participant.join_time) {
      continue;
    }

    const joinTime = DateTime.fromISO(participant.join_time, {
      zone: 'utc',
    }).setZone(timezone);

    if (joinTime < slotEndTime) {
      uniqueParticipants.add(getParticipantKey(participant));
    }
  }

  return uniqueParticipants.size;
}

function generateTimeWiseReport(participants, config) {
  const {
    reportTitle,
    batchName,
    reportDate,
    sessionName,
    startTime,
    endTime,
    intervalMinutes,
    timezone,
  } = config;

  const [day, month, year] = reportDate.split('/').map(Number);
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);

  let currentSlot = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: startHour,
      minute: startMinute,
    },
    {
      zone: timezone,
    }
  );

  const finalSlot = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: endHour,
      minute: endMinute,
    },
    {
      zone: timezone,
    }
  );

  const lines = [];

  lines.push(reportTitle);
  lines.push(batchName);
  lines.push('');
  lines.push(`*${reportDate}* - ${sessionName}`);
  lines.push('');

  while (currentSlot <= finalSlot) {
    const count = countParticipantsJoinedUntil(
      participants,
      currentSlot,
      intervalMinutes,
      timezone
    );

    const displayTime = formatDisplayTime(currentSlot);
    const paddedCount = String(count).padStart(7, ' ');

    lines.push(`${displayTime} - ${paddedCount}`);

    currentSlot = currentSlot.plus({ minutes: intervalMinutes });
  }

  return lines.join('\n');
}

function generateNameWiseJapaReport(participants, config) {
  const rows = getMergedParticipantRows(participants, config.timezone);

  const lines = [];

  lines.push(`Daily Zoom Japa Report - ${config.reportDateShort}`);
  lines.push(`Total Devotees Attended: ${rows.length}`);
  lines.push('');

  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.name}`);
    lines.push(
      `   Join: ${row.firstJoinTime.toFormat('HH:mm')} | Duration: ${row.totalDurationMinutes} mins`
    );
    lines.push('');
  });

  return lines.join('\n').trim();
}

function verifyZoomSignature(req) {
  const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

  const timestamp = req.headers['x-zm-request-timestamp'];
  const signature = req.headers['x-zm-signature'];

  if (!secretToken || !timestamp || !signature) {
    return false;
  }

  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;

  const hash = crypto
    .createHmac('sha256', secretToken)
    .update(message)
    .digest('hex');

  return signature === `v0=${hash}`;
}

function handleZoomUrlValidation(body) {
  console.log('Handling Zoom URL validation');

  const plainToken = body?.payload?.plainToken;
  const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

  console.log('Plain token exists:', !!plainToken);
  console.log('Secret token exists:', !!secretToken);

  if (!plainToken) {
    throw new Error('Zoom plainToken missing');
  }

  if (!secretToken) {
    throw new Error('ZOOM_WEBHOOK_SECRET_TOKEN missing');
  }

  const encryptedToken = crypto
    .createHmac('sha256', secretToken)
    .update(plainToken)
    .digest('hex');

  return {
    plainToken,
    encryptedToken,
  };
}
async function sendWhatsAppMessage(text) {
  if (
    !process.env.META_WHATSAPP_TOKEN ||
    !process.env.META_PHONE_NUMBER_ID ||
    !process.env.WHATSAPP_REPORT_TO
  ) {
    console.log('Meta WhatsApp values are missing. Skipping WhatsApp send.');
    return;
  }

  const response = await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: process.env.WHATSAPP_REPORT_TO,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.META_WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log('WhatsApp message sent via Meta Cloud API');
  console.log(JSON.stringify(response.data));
}

async function processMeetingEndedEvent(body) {
  const meeting = body.payload.object;

  const meetingUuid = meeting.uuid;
  const topic = meeting.topic || 'Daily Zoom Japa';

  const meetingIdFromZoom = String(meeting.id || '').replace(/\s/g, '');
  const dailyJapaMeetingId = String(process.env.DAILY_JAPA_MEETING_ID || '').replace(/\s/g, '');
  const dailyJapaTopic = process.env.DAILY_JAPA_TOPIC || 'Daily Zoom Japa';

  const isDailyJapaMeeting =
    meetingIdFromZoom === dailyJapaMeetingId ||
    topic === dailyJapaTopic;

  const timezone = process.env.REPORT_TIMEZONE || 'Europe/London';
  const intervalMinutes = Number(process.env.REPORT_INTERVAL_MINUTES || 15);

  const dynamicRange = getDynamicReportTimeRange(
    meeting,
    timezone,
    intervalMinutes
  );

  const config = {
    reportTitle: process.env.REPORT_TITLE || 'Daily Zoom Japa Attendance',
    batchName: process.env.BATCH_NAME || 'Daily Japa Report',
    reportDate: dynamicRange.reportDate,
    reportDateShort: dynamicRange.reportDateShort,
    sessionName: topic,
    startTime: dynamicRange.startTime,
    endTime: dynamicRange.endTime,
    intervalMinutes,
    timezone,
  };

  console.log('Meeting ended event received');
  console.log('Topic:', topic);
  console.log('Meeting ID:', meetingIdFromZoom);
  console.log('Meeting UUID:', meetingUuid);
  console.log('Report date:', config.reportDate);
  console.log('Start time:', config.startTime);
  console.log('End time:', config.endTime);
  console.log('Timezone:', config.timezone);

  console.log('Waiting 90 seconds for Zoom report to become ready...');
  await new Promise(resolve => setTimeout(resolve, 90000));

  const participants = await getMeetingParticipants(meetingUuid);

  console.log('Participants fetched:', participants.length);

  const participantRows = getMergedParticipantRows(participants, config.timezone);
  const timeWiseReport = generateTimeWiseReport(participants, config);
  const nameWiseReport = generateNameWiseJapaReport(participants, config);

  const finalReport =
    timeWiseReport +
    '\n\n----------------------------\n\n' +
    nameWiseReport;

  console.log('');
  console.log(finalReport);
  console.log('');

  let whatsappSent = false;

  if (isDailyJapaMeeting) {
    try {
      await sendWhatsAppMessage('```\n' + finalReport + '\n```');
      whatsappSent = true;
    } catch (error) {
      console.error('WhatsApp send failed, but report will still be saved');

      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Response:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error(error.message);
      }
    }
  } else {
    console.log('WhatsApp skipped because this is not Daily Zoom Japa');
  }

  try {
    const savedReport = await saveAttendanceReport({
      config,
      meetingId: meetingIdFromZoom,
      meetingUuid,
      topic,
      participantRows,
      timeWiseReport,
      nameWiseReport,
      finalReport,
      whatsappSent,
    });

    if (savedReport) {
      const baseUrl =
        process.env.PUBLIC_BASE_URL ||
        'https://zoom-whatsapp-report-production.up.railway.app';

      const reportUrl = `${baseUrl}/admin/reports/${savedReport.public_id}`;

      console.log('Attendance report saved successfully');
      console.log('Report URL:', reportUrl);
    }
  } catch (error) {
    console.error('Failed to save attendance report:', error.message);
  }
}

app.get('/health', (req, res) => {
  res.send('Zoom WhatsApp server is running');
});

app.get('/login', (req, res) => {
  const error = req.query.error ? 'Invalid username or password' : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  return res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ISKCON READING Attendance Reports</title>
        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg, #fff7ed, #fde68a, #dcfce7);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }

          .login-wrapper {
            width: 100%;
            max-width: 900px;
          }

          .login-card {
            background: rgba(255,255,255,0.96);
            border-radius: 26px;
            box-shadow: 0 14px 40px rgba(0,0,0,0.14);
            overflow: hidden;
            border: 1px solid #fde68a;
          }

          .top-banner {
            background: linear-gradient(90deg, #7c2d12, #b45309, #92400e);
            padding: 18px 24px;
            text-align: center;
          }

          .mahamantra {
            font-size: 18px;
            font-weight: bold;
            color: #fff7ed;
            line-height: 1.5;
            letter-spacing: 0.2px;
          }

          .card-body {
            padding: 32px 42px 42px;
          }

          .logo-row {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 28px;
            flex-wrap: wrap;
            margin-bottom: 18px;
          }

          .iskcon-logo {
            height: 88px;
            width: 88px;
            object-fit: contain;
          }

          .prabhupada-logo {
            height: 96px;
            width: 96px;
            object-fit: cover;
            border-radius: 50%;
            border: 4px solid #fcd34d;
            background: #fff7ed;
            box-shadow: 0 4px 14px rgba(0,0,0,0.12);
          }

          h1 {
            text-align: center;
            font-size: 42px;
            margin: 10px 0 8px;
            color: #111827;
          }

          .subtitle {
            text-align: center;
            font-size: 18px;
            color: #4b5563;
            margin-bottom: 30px;
          }

          label {
            display: block;
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #111827;
          }

          input[type="text"],
          input[type="password"] {
            width: 100%;
            box-sizing: border-box;
            padding: 17px 20px;
            font-size: 20px;
            border: 2px solid #d1d5db;
            border-radius: 16px;
            margin-bottom: 24px;
            outline: none;
            transition: 0.2s ease;
            background: #ffffff;
          }

          input[type="text"]:focus,
          input[type="password"]:focus {
            border-color: #f59e0b;
            box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.18);
          }

          button {
            width: 100%;
            padding: 18px 20px;
            font-size: 24px;
            font-weight: 700;
            border: 0;
            border-radius: 16px;
            background: linear-gradient(90deg, #0f172a, #1e3a8a);
            color: white;
            cursor: pointer;
          }

          button:hover {
            opacity: 0.95;
          }

          .error {
            color: #b91c1c;
            background: #fee2e2;
            border: 1px solid #fecaca;
            padding: 12px 16px;
            border-radius: 12px;
            margin-bottom: 18px;
            text-align: center;
            font-size: 16px;
          }

          @media (max-width: 640px) {
            h1 {
              font-size: 30px;
            }

            .card-body {
              padding: 24px;
            }

            .mahamantra {
              font-size: 14px;
            }

            label {
              font-size: 18px;
            }

            input[type="text"],
            input[type="password"] {
              font-size: 18px;
              padding: 14px 16px;
            }

            button {
              font-size: 20px;
              padding: 16px;
            }

            .iskcon-logo {
              height: 70px;
              width: 70px;
            }

            .prabhupada-logo {
              height: 78px;
              width: 78px;
            }
          }
        </style>
      </head>
      <body>
        <div class="login-wrapper">
          <div class="login-card">
            <div class="top-banner">
              <div class="mahamantra">
                Hare Krishna Hare Krishna Krishna Krishna Hare Hare<br/>
                Hare Rama Hare Rama Rama Rama Hare Hare
              </div>
            </div>

            <div class="card-body">
              <div class="logo-row">
                <img class="iskcon-logo" src="/public/images/iskcon-logo.png" alt="ISKCON Logo" />
                <img class="prabhupada-logo" src="/public/images/prabhupada-icon.png" alt="Srila Prabhupada" />
              </div>

              <h1>ISKCON READING Attendance Reports</h1>
              <div class="subtitle">Zoom attendance management for all meeting IDs</div>

              ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

              <form method="POST" action="/login">
                <label>Username</label>
                <input type="text" name="username" required />

                <label>Password</label>
                <input type="password" name="password" required />

                <button type="submit">Login</button>
              </form>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
});
app.post('/login', (req, res) => {
  const username = req.body.username || '';
  const password = req.body.password || '';

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || '';

  if (username === adminUsername && password === adminPassword) {
    req.session.isAdminLoggedIn = true;
    return res.redirect('/admin/reports');
  }

  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', (req, res) => {
  return res.redirect('/admin/reports');
});

app.post('/admin/reports/generate', requireLogin, async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(500).send('Database is not configured');
    }

    const rawMeeting = decodeMeetingFromForm(req.body.meetingData);
    const meeting = normalizeMeetingForReport(rawMeeting);

    const meetingUuid = meeting.uuid;
    const topic = meeting.topic || 'Zoom Meeting';
    const meetingIdFromZoom = String(meeting.id || '').replace(/\s/g, '');

    if (!meetingUuid) {
      return res.status(400).send('Selected meeting does not have a Zoom UUID');
    }

    const timezone = process.env.REPORT_TIMEZONE || 'Europe/London';
    const intervalMinutes = Number(process.env.REPORT_INTERVAL_MINUTES || 15);

    const dynamicRange = getDynamicReportTimeRange(
      meeting,
      timezone,
      intervalMinutes
    );

    const config = {
      reportTitle: process.env.REPORT_TITLE || 'Daily Zoom Japa Attendance',
      batchName: process.env.BATCH_NAME || 'Daily Japa Report',
      reportDate: dynamicRange.reportDate,
      reportDateShort: dynamicRange.reportDateShort,
      sessionName: topic,
      startTime: dynamicRange.startTime,
      endTime: dynamicRange.endTime,
      intervalMinutes,
      timezone,
    };

    console.log('Manual report generation started');
    console.log('Topic:', topic);
    console.log('Meeting ID:', meetingIdFromZoom);
    console.log('Meeting UUID:', meetingUuid);
    console.log('Report date:', config.reportDate);

    const participants = await getMeetingParticipants(meetingUuid);

    console.log('Participants fetched:', participants.length);

    const participantRows = getMergedParticipantRows(participants, config.timezone);
    const timeWiseReport = generateTimeWiseReport(participants, config);
    const nameWiseReport = generateNameWiseJapaReport(participants, config);

    const finalReport =
      timeWiseReport +
      '\n\n----------------------------\n\n' +
      nameWiseReport;

    const savedReport = await saveAttendanceReport({
      config,
      meetingId: meetingIdFromZoom,
      meetingUuid,
      topic,
      participantRows,
      timeWiseReport,
      nameWiseReport,
      finalReport,
      whatsappSent: false,
    });

    if (!savedReport) {
      return res.status(500).send('Report could not be saved');
    }

    return res.redirect(`/admin/reports/${savedReport.public_id}`);
  } catch (error) {
    console.error('Manual report generation failed:', error.message);

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }

    return res.status(500).send(`Manual report generation failed: ${escapeHtml(error.message)}`);
  }
});

app.get('/admin/reports', requireLogin, async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(500).send('Database is not configured');
    }

    const date = req.query.date || '';
    const topic = req.query.topic || '';
    const meetingId = req.query.meetingId || '';
    const generateDate = req.query.generateDate || '';

    const timezone = process.env.REPORT_TIMEZONE || 'Europe/London';

    let zoomMeetings = [];
    let generateError = '';

    if (generateDate) {
      try {
        zoomMeetings = await getZoomMeetingsForDate(generateDate);
      } catch (err) {
        console.error('Failed to fetch Zoom meetings:', err.message);
        generateError = err.message;
      }
    }

    const meetingOptions = zoomMeetings.map(meeting => {
      const normalizedMeeting = normalizeMeetingForReport(meeting);
      const value = encodeMeetingForForm(normalizedMeeting);
      const label = getMeetingDropdownLabel(normalizedMeeting, timezone);

      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    }).join('');

    const generateSectionHtml = `
      <div class="generate-box">
        <h2>Generate Report</h2>

        <form class="generate-form" method="GET" action="/admin/reports">
          <label>Select Date</label>
          <div class="inline-row">
            <input type="date" name="generateDate" value="${escapeHtml(generateDate)}" required />
            <button type="submit">Load Zoom Meetings</button>
          </div>
        </form>

        ${
          generateError
            ? `<div class="error">Error: ${escapeHtml(generateError)}</div>`
            : ''
        }

        ${
          generateDate && zoomMeetings.length === 0 && !generateError
            ? `<div class="note">No Zoom meetings found for this date.</div>`
            : ''
        }

        ${
          zoomMeetings.length > 0
            ? `
              <form class="generate-form" method="POST" action="/admin/reports/generate">
                <label>Select Meeting</label>
                <select name="meetingData" required>
                  ${meetingOptions}
                </select>

                <button type="submit">Generate & Save Report</button>
              </form>
            `
            : ''
        }
      </div>
    `;

    const conditions = [];
    const params = [];

    if (date) {
      params.push(date);
      conditions.push(`report_date = $${params.length}`);
    }

    if (topic) {
      params.push(`%${topic}%`);
      conditions.push(`topic ILIKE $${params.length}`);
    }

    if (meetingId) {
      params.push(`%${meetingId}%`);
      conditions.push(`zoom_meeting_id ILIKE $${params.length}`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const result = await dbPool.query(
      `
        SELECT
          public_id,
          report_date,
          session_name,
          zoom_meeting_id,
          topic,
          start_time,
          end_time,
          participant_count,
          whatsapp_sent,
          created_at
        FROM attendance_reports
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT 200;
      `,
      params
    );

    const rowsHtml = result.rows.map(report => `
      <tr>
        <td>${escapeHtml(report.report_date)}</td>
        <td>${escapeHtml(report.session_name)}</td>
        <td>${escapeHtml(report.zoom_meeting_id)}</td>
        <td>${escapeHtml(report.start_time)} - ${escapeHtml(report.end_time)}</td>
        <td>${escapeHtml(report.participant_count)}</td>
        <td>${report.whatsapp_sent ? 'Yes' : 'No'}</td>
        <td>
          <a href="/admin/reports/${report.public_id}">View</a>
          |
          <a href="/admin/reports/${report.public_id}/download">Download</a>
        </td>
      </tr>
    `).join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Attendance Reports</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background: #f3f4f6;
              margin: 0;
              padding: 20px;
            }

            .container {
              max-width: 1100px;
              margin: 0 auto;
              background: #ffffff;
              padding: 24px;
              border-radius: 12px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            }

            .devotional-header {
            background: linear-gradient(90deg, #fff7ed, #fde68a, #dcfce7);
            border: 1px solid #fcd34d;
            border-radius: 18px;
            padding: 18px 22px;
            margin-bottom: 24px;
            }

           .mantra {
           text-align: center;
           font-weight: bold;
           color: #7c2d12;
           line-height: 1.6;
           margin-bottom: 16px;
           font-size: 17px;
           }

          .header-main {
           display: flex;
           align-items: center;
           justify-content: space-between;
           gap: 20px;
          flex-wrap: wrap;
           }

          .header-logos {
           display: flex;
           gap: 16px;
           align-items: center;
           }

          .header-logos .iskcon-logo {
          height: 72px;
           width: 72px;
           object-fit: contain;
           }

.header-logos .prabhupada-logo {
  height: 78px;
  width: 78px;
  object-fit: cover;
  border-radius: 50%;
  border: 3px solid #fcd34d;
  background: #fff7ed;
  box-shadow: 0 3px 10px rgba(0,0,0,0.12);
}

.header-text {
  flex: 1;
  min-width: 260px;
}

.header-text h1 {
  margin: 0;
  font-size: 34px;
  color: #111827;
}

.header-text p {
  margin: 8px 0 0;
  color: #4b5563;
  font-size: 16px;
}

            .topbar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 12px;
              flex-wrap: wrap;
            }

            h1 {
              margin: 0 0 20px 0;
              font-size: 26px;
            }

            h2 {
              margin-top: 0;
              font-size: 20px;
            }

            .generate-box {
            background: linear-gradient(135deg, #fff7ed, #fffbeb);
            border: 1px solid #fcd34d;
            border-radius: 16px;
            padding: 18px;
            margin-bottom: 22px;
            }

            .generate-form {
              margin-top: 12px;
            }

            .inline-row {
              display: flex;
              gap: 10px;
              flex-wrap: wrap;
              align-items: center;
              margin-top: 6px;
            }

            label {
              display: block;
              font-weight: bold;
              margin-top: 10px;
            }

            form.filter {
              display: flex;
              gap: 10px;
              flex-wrap: wrap;
              margin-bottom: 18px;
            }

            input, select {
              padding: 9px;
              border: 1px solid #d1d5db;
              border-radius: 8px;
              font-size: 14px;
            }

            select {
              width: 100%;
              margin-top: 6px;
            }

            button, .button {
              padding: 9px 13px;
              border: 0;
              border-radius: 8px;
              background: #111827;
              color: #ffffff;
              text-decoration: none;
              cursor: pointer;
            }

            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 12px;
            }

            th, td {
              border-bottom: 1px solid #e5e7eb;
              padding: 10px;
              text-align: left;
              font-size: 14px;
            }

            th {
              background: #f9fafb;
            }

            a {
              color: #1d4ed8;
            }

            .logout {
              display: inline;
            }

            .logout button {
              background: #6b7280;
            }

            .error {
              color: #b91c1c;
              margin-top: 12px;
            }

            .note {
              color: #4b5563;
              margin-top: 12px;
            }
          </style>
        </head>
        <body>
          <div class="container">
          <div class="devotional-header">
  <div class="mantra">
    Hare Krishna Hare Krishna Krishna Krishna Hare Hare
    <br />
    Hare Rama Hare Rama Rama Rama Hare Hare
  </div>

  <div class="header-main">
    <div class="header-logos">
      <img class="iskcon-logo" src="/public/images/iskcon-logo.png" alt="ISKCON Logo" />
      <img class="prabhupada-logo" src="/public/images/prabhupada-icon.png" alt="Srila Prabhupada" />
    </div>

    <div class="header-text">
      <h1>ISKCON READING Attendance Reports</h1>
      <p>Manage Zoom attendance reports for all meeting IDs</p>
    </div>

    <form class="logout" method="POST" action="/logout">
      <button type="submit">Logout</button>
    </form>
  </div>
</div>

${generateSectionHtml}

<h2>Saved Reports</h2>

            <form class="filter" method="GET" action="/admin/reports">
              <input type="text" name="date" placeholder="Date e.g. 04/08/2026" value="${escapeHtml(date)}" />
              <input type="text" name="topic" placeholder="Topic" value="${escapeHtml(topic)}" />
              <input type="text" name="meetingId" placeholder="Meeting ID" value="${escapeHtml(meetingId)}" />
              <button type="submit">Filter</button>
              <a class="button" href="/admin/reports">Clear</a>
            </form>

            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Session</th>
                  <th>Meeting ID</th>
                  <th>Time</th>
                  <th>Participants</th>
                  <th>WhatsApp Sent</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  rowsHtml ||
                  '<tr><td colspan="7">No reports found yet.</td></tr>'
                }
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Failed to load reports:', error.message);
    return res.status(500).send('Failed to load reports');
  }
});

app.get('/admin/reports/:publicId', requireLogin, async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(500).send('Database is not configured');
    }

    const publicId = req.params.publicId;

    const result = await dbPool.query(
      `
        SELECT *
        FROM attendance_reports
        WHERE public_id = $1;
      `,
      [publicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('Report not found');
    }

    const report = result.rows[0];

    const recordsResult = await dbPool.query(
      `
        SELECT participant_name, join_time, duration_minutes
        FROM attendance_records
        WHERE report_public_id = $1
        ORDER BY id ASC;
      `,
      [publicId]
    );

    const recordsHtml = recordsResult.rows.map((record, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(record.participant_name)}</td>
        <td>${escapeHtml(record.join_time)}</td>
        <td>${escapeHtml(record.duration_minutes)} mins</td>
      </tr>
    `).join('');

    const whatsappText = '```\n' + report.final_report + '\n```';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Report - ${escapeHtml(report.report_date)}</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background: #f3f4f6;
              margin: 0;
              padding: 20px;
            }

            .container {
              max-width: 1000px;
              margin: 0 auto;
              background: #ffffff;
              padding: 24px;
              border-radius: 12px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            }

            h1 {
              margin-top: 0;
              font-size: 26px;
            }

            .meta {
              color: #374151;
              line-height: 1.7;
              margin-bottom: 18px;
            }

            .actions {
              display: flex;
              gap: 10px;
              flex-wrap: wrap;
              margin: 18px 0;
            }

            .button, button {
              padding: 9px 13px;
              border: 0;
              border-radius: 8px;
              background: #111827;
              color: #ffffff;
              text-decoration: none;
              cursor: pointer;
              font-size: 14px;
            }

            .secondary {
              background: #6b7280;
            }

            pre {
              background: #111827;
              color: #f9fafb;
              padding: 16px;
              border-radius: 8px;
              overflow-x: auto;
              white-space: pre-wrap;
              word-wrap: break-word;
              font-size: 14px;
              line-height: 1.5;
            }

            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 18px;
            }

            th, td {
              border-bottom: 1px solid #e5e7eb;
              padding: 9px;
              text-align: left;
              font-size: 14px;
            }

            th {
              background: #f9fafb;
            }

            a {
              color: #1d4ed8;
            }

            textarea {
              position: absolute;
              left: -9999px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <a href="/admin/reports">← Back to reports</a>

            <h1>Attendance Report</h1>

            <div class="meta">
              <strong>Date:</strong> ${escapeHtml(report.report_date)}<br/>
              <strong>Session:</strong> ${escapeHtml(report.session_name)}<br/>
              <strong>Topic:</strong> ${escapeHtml(report.topic)}<br/>
              <strong>Meeting ID:</strong> ${escapeHtml(report.zoom_meeting_id)}<br/>
              <strong>Meeting UUID:</strong> ${escapeHtml(report.zoom_uuid)}<br/>
              <strong>Time:</strong> ${escapeHtml(report.start_time)} - ${escapeHtml(report.end_time)}<br/>
              <strong>Participants:</strong> ${escapeHtml(report.participant_count)}<br/>
              <strong>WhatsApp Sent:</strong> ${report.whatsapp_sent ? 'Yes' : 'No'}<br/>
              <strong>Created:</strong> ${escapeHtml(report.created_at)}
            </div>

            <div class="actions">
              <a class="button" href="/admin/reports/${report.public_id}/download">Download .txt</a>
              <button type="button" onclick="copyReport()">Copy WhatsApp Report</button>
              <a class="button secondary" href="/admin/reports">Back</a>
            </div>

            <textarea id="copyText">${escapeHtml(whatsappText)}</textarea>

            <h2>Full Report</h2>
            <pre>${escapeHtml(report.final_report)}</pre>

            <h2>Participant Records</h2>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Join</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                ${
                  recordsHtml ||
                  '<tr><td colspan="4">No participant records found.</td></tr>'
                }
              </tbody>
            </table>
          </div>

          <script>
            function copyReport() {
              const text = document.getElementById('copyText').value;

              if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(function () {
                  alert('WhatsApp report copied.');
                });
                return;
              }

              const textarea = document.getElementById('copyText');
              textarea.select();
              document.execCommand('copy');
              alert('WhatsApp report copied.');
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Failed to load report:', error.message);
    return res.status(500).send('Failed to load report');
  }
});

app.get('/admin/reports/:publicId/download', requireLogin, async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(500).send('Database is not configured');
    }

    const publicId = req.params.publicId;

    const result = await dbPool.query(
      `
        SELECT *
        FROM attendance_reports
        WHERE public_id = $1;
      `,
      [publicId]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('Report not found');
    }

    const report = result.rows[0];
    const filename = `attendance-report-${report.report_date.replace(/\//g, '-')}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(report.final_report);
  } catch (error) {
    console.error('Failed to download report:', error.message);
    return res.status(500).send('Failed to download report');
  }
});

app.get('/debug/env', (req, res) => {
  res.json({
    hasZoomAccountId: !!process.env.ZOOM_ACCOUNT_ID,
    hasZoomClientId: !!process.env.ZOOM_CLIENT_ID,
    hasZoomClientSecret: !!process.env.ZOOM_CLIENT_SECRET,
    hasZoomWebhookSecretToken: !!process.env.ZOOM_WEBHOOK_SECRET_TOKEN,
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    dailyJapaMeetingId: process.env.DAILY_JAPA_MEETING_ID || null,
    timezone: process.env.REPORT_TIMEZONE || null,
  });
});

app.post('/zoom/webhook', async (req, res) => {
  try {
    const body = req.body;

    console.log('Zoom webhook received:', body.event);

    if (body.event === 'endpoint.url_validation') {
      return res.status(200).json(handleZoomUrlValidation(body));
    }

    if (!verifyZoomSignature(req)) {
      console.log('Invalid Zoom webhook signature');
      return res.status(401).send('Invalid signature');
    }

    if (
      body.event === 'meeting.ended' ||
      body.event === 'meeting.ended.v2' ||
      body.event === 'meeting.end'
    ) {
      res.status(200).send('Meeting ended received');

      processMeetingEndedEvent(body).catch(error => {
        console.error('Failed to process meeting ended event');

        if (error.response) {
          console.error('Status:', error.response.status);
          console.error('Response:', error.response.data);
        } else {
          console.error(error.message);
        }
      });

      return;
    }

    return res.status(200).send('Event ignored');
  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(500).send('Internal server error');
  }
});

const port = process.env.PORT || 3000;

app.get('/meta/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Meta webhook verification request received');

  if (
    mode === 'subscribe' &&
    token === process.env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    console.log('Meta webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.log('Meta webhook verification failed');
  return res.sendStatus(403);
});

app.post('/meta/webhook', (req, res) => {
  console.log('Meta webhook event received');
  console.log(JSON.stringify(req.body, null, 2));

  const entries = req.body.entry || [];

  for (const entry of entries) {
    const changes = entry.changes || [];

    for (const change of changes) {
      const value = change.value || {};

      if (value.statuses) {
        for (const status of value.statuses) {
          console.log('WhatsApp message status update');
          console.log('Message ID:', status.id);
          console.log('Status:', status.status);
          console.log('Timestamp:', status.timestamp);
          console.log('Recipient:', status.recipient_id);

          if (status.errors) {
            console.log('Status errors:', JSON.stringify(status.errors, null, 2));
          }
        }
      }

      if (value.messages) {
        for (const message of value.messages) {
          console.log('Incoming WhatsApp message');
          console.log('From:', message.from);
          console.log('Message type:', message.type);

          if (message.text) {
            console.log('Text:', message.text.body);
          }
        }
      }
    }
  }

  return res.sendStatus(200);
});

app.listen(port, '0.0.0.0', async () => {
  console.log(`Server running on port ${port}`);
  console.log('Health check: /health');

  try {
    await initializeDatabase();
  } catch (error) {
    console.error('Database initialization failed:', error.message);
  }
});