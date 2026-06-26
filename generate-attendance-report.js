require('dotenv').config();
const axios = require('axios');
const { DateTime } = require('luxon');

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

function generateNameWiseJapaReport(participants, config) {
  const {
    reportDate,
    timezone,
  } = config;

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

  lines.push(`Daily Zoom Jap Report - ${reportDate}`);
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

    

  function countParticipantsAtTime(participants, slotDateTime) {
  let count = 0;

  const slotWithGrace = slotDateTime.plus({ minutes: 1 });

  for (const participant of participants) {
    if (!participant.join_time || !participant.leave_time) {
      continue;
    }

    const joinTime = DateTime.fromISO(participant.join_time, {
      zone: 'utc',
    }).setZone('Europe/London');

    const leaveTime = DateTime.fromISO(participant.leave_time, {
      zone: 'utc',
    }).setZone('Europe/London');

    if (joinTime <= slotWithGrace && leaveTime >= slotDateTime) {
      count++;
    }
  }

  return count;
}

function formatDisplayTime(dateTime) {
  const hour = dateTime.hour;
  const minute = String(dateTime.minute).padStart(2, '0');

  const suffix = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;

  return `${hour12}.${minute}${suffix}`;
}

function countParticipantsJoinedUntil(
  participants,
  reportStartTime,
  slotDateTime,
  intervalMinutes
) {
  let uniqueParticipants = new Set();

  const slotEndTime = slotDateTime.plus({ minutes: intervalMinutes });

  for (const participant of participants) {
    if (!participant.join_time) {
      continue;
    }

    const joinTime = DateTime.fromISO(participant.join_time, {
      zone: 'utc',
    }).setZone('Europe/London');

    if (joinTime >= reportStartTime && joinTime < slotEndTime) {
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
      zone: 'Europe/London',
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
      zone: 'Europe/London',
    }
  );

  const lines = [];

  lines.push(reportTitle);
  lines.push(batchName);
  lines.push('');
  lines.push(`*${reportDate}* - ${sessionName}`);
  lines.push('');

  const reportStartTime = currentSlot;

while (currentSlot <= finalSlot) {
  const count = countParticipantsJoinedUntil(
    participants,
    reportStartTime,
    currentSlot,
    intervalMinutes
  );

  const displayTime = formatDisplayTime(currentSlot);
  const paddedCount = String(count).padStart(7, ' ');

  lines.push(`${displayTime} - ${paddedCount}`);

  currentSlot = currentSlot.plus({ minutes: intervalMinutes });
}

  return lines.join('\n');
}

async function main() {
  try {
    const meetingUuid = 'Rirv++V5RaeRBRC5ThcRVQ==';

    const participants = await getMeetingParticipants(meetingUuid);

   const nameWiseReport = generateNameWiseJapaReport(participants, {
  reportDate: '11/05/26',
  timezone: 'Europe/London',
});

console.log('');
console.log(nameWiseReport);

 const report = generateTimeWiseReport(participants, {
      reportTitle: '18 days BG class Attendance',
      batchName: 'January 19 /2026 - 9PM Batch',
      reportDate: '31/05/2026',
      sessionName: "ISKCON READING's Personal Meeting Room",
      startTime: '07:00',
      endTime: '09:45',
      intervalMinutes: 15,
    });

    console.log(report);
  } catch (error) {
    console.error('Failed to generate attendance report');

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

main();
