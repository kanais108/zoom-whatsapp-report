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

async function getZoomUsers() {
  try {
    const token = await getZoomAccessToken();

    const response = await axios.get(
      'https://api.zoom.us/v2/users',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          status: 'active',
          page_size: 30,
        },
      }
    );

    console.log('Zoom users fetched successfully');
    console.log('');

    const users = response.data.users || [];

    if (users.length === 0) {
      console.log('No users found.');
      return;
    }

    users.forEach((user, index) => {
      console.log(`${index + 1}. ${user.first_name || ''} ${user.last_name || ''}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Type: ${user.type}`);
      console.log('');
    });
  } catch (error) {
    console.error('Failed to fetch Zoom users');

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

getZoomUsers();
