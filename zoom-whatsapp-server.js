require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

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
      const participantKey =
        participant.user_id ||
        participant.email ||
        participant.name ||
        participant.id ||
        `${participant.name}-${participant.join_time}`;

      uniqueParticipants.add(participantKey);
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
  const { reportDateShort, timezone } = config;

  const uniqueMap = new Map();

  for (const participant of participants) {
    if (!participant.join_time) {
      continue;
    }

    const name =
      participant.name ||
      participant.user_name ||
      participant.email ||
      'Unknown';

    const joinTime = DateTime.fromISO(participant.join_time, {
      zone: 'utc',
    }).setZone(timezone);

    const durationSeconds = participant.duration || 0;
    const durationMinutes = Math.round(durationSeconds / 60);

    const existing = uniqueMap.get(name);

    if (!existing) {
      uniqueMap.set(name, {
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

  const rows = Array.from(uniqueMap.values())
    .sort((a, b) => a.firstJoinTime.toMillis() - b.firstJoinTime.toMillis());

  const lines = [];

  lines.push(`Daily Zoom Jap Report - ${reportDateShort}`);
  lines.push(`Total Devotees Attended: ${rows.length}`);
  lines.push('');

  const nameHeader = 'Name'.padEnd(30, ' ');
  const joinHeader = 'Join Time'.padEnd(12, ' ');
  const durationHeader = 'Duration (minutes)';

  lines.push(`${nameHeader}${joinHeader}${durationHeader}`);

  for (const row of rows) {
    const nameText = row.name.length > 29
      ? row.name.substring(0, 29)
      : row.name;

    const name = nameText.padEnd(30, ' ');
    const joinTime = row.firstJoinTime.toFormat('HH:mm').padEnd(12, ' ');
    const duration = String(row.totalDurationMinutes);

    lines.push(`${name}${joinTime}${duration}`);
  }

  return lines.join('\n');
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

  if (
    meetingIdFromZoom !== dailyJapaMeetingId &&
    topic !== dailyJapaTopic
  ) {
    console.log('Meeting ignored because it is not Daily Zoom Japa');
    console.log('Topic:', topic);
    console.log('Meeting ID:', meetingIdFromZoom);
    return;
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

  console.log('Daily Japa meeting ended event received');
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

  const timeWiseReport = generateTimeWiseReport(participants, config);
  const nameWiseReport = generateNameWiseJapaReport(participants, config);

  const finalReport =
    timeWiseReport +
    '\n\n----------------------------\n\n' +
    nameWiseReport;

  console.log('');
  console.log(finalReport);
  console.log('');
await sendWhatsAppMessage(finalReport);
}

app.get('/health', (req, res) => {
  res.send('Zoom WhatsApp server is running');
});

app.get('/debug/env', (req, res) => {
  res.json({
    hasZoomAccountId: !!process.env.ZOOM_ACCOUNT_ID,
    hasZoomClientId: !!process.env.ZOOM_CLIENT_ID,
    hasZoomClientSecret: !!process.env.ZOOM_CLIENT_SECRET,
    hasZoomWebhookSecretToken: !!process.env.ZOOM_WEBHOOK_SECRET_TOKEN,
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  console.log('Health check: /health');
});