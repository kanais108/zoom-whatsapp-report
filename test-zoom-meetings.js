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

async function getMeetingReports() {
  try {
    const token = await getZoomAccessToken();

    const today = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 30);

    const fromDate = pastDate.toISOString().split('T')[0];
    const toDate = today.toISOString().split('T')[0];

    const response = await axios.get(
      'https://api.zoom.us/v2/report/users/info@iskconreading.org/meetings',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          from: fromDate,
          to: toDate,
          page_size: 10,
        },
      }
    );

    console.log('Meeting reports fetched successfully');
    console.log('From:', fromDate);
    console.log('To:', toDate);
    console.log('');

    const meetings = response.data.meetings || [];

    if (meetings.length === 0) {
      console.log('No meetings found in the last 30 days.');
      return;
    }

    meetings.forEach((meeting, index) => {
      console.log(`${index + 1}. ${meeting.topic}`);
      console.log(`   Meeting ID: ${meeting.id}`);
      console.log(`   UUID: ${meeting.uuid}`);
      console.log(`   Start Time: ${meeting.start_time}`);
      console.log(`   End Time: ${meeting.end_time}`);
      console.log(`   Participants: ${meeting.participants_count}`);
      console.log('');
    });
  } catch (error) {
    console.error('Failed to fetch Zoom meeting reports');

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

getMeetingReports();
