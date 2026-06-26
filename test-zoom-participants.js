require('dotenv').config();
const axios = require('axios');

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
  // One encode is normally enough.
  // If UUID starts with "/" or contains "//", Zoom may need double encode.
  let encoded = encodeURIComponent(uuid);

  if (uuid.startsWith('/') || uuid.includes('//')) {
    encoded = encodeURIComponent(encoded);
  }

  return encoded;
}

async function getMeetingParticipants() {
  try {
    const token = await getZoomAccessToken();

    // Use meeting #8 first
    const meetingUuid = 'Rirv++V5RaeRBRC5ThcRVQ==';
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

      const participants = response.data.participants || [];
      allParticipants.push(...participants);

      nextPageToken = response.data.next_page_token || '';
    } while (nextPageToken);

    console.log('Participants fetched successfully');
    console.log('Total records:', allParticipants.length);
    console.log('');

    allParticipants.slice(0, 10).forEach((p, index) => {
      console.log(`${index + 1}. ${p.name || p.user_name || p.email || 'Unknown'}`);
      console.log(`   Join: ${p.join_time}`);
      console.log(`   Leave: ${p.leave_time}`);
      console.log(`   Duration: ${p.duration}`);
      console.log('');
    });
  } catch (error) {
    console.error('Failed to fetch participants');

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

getMeetingParticipants();
