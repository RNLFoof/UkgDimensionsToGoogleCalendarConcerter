const fs = require('fs').promises;
const path = require('path');

const {authenticate} = require('@google-cloud/local-auth');
import {
  google,   // The top level object used to access services
  calendar_v3, // For every service client, there is an exported namespace
  Auth,     // Namespace for auth related types
  Common,
  GoogleApis,   // General types used throughout the library
} from 'googleapis';
import { calendar } from 'googleapis/build/src/apis/calendar';

import {
  JSDOM
} from 'jsdom';
import _ from 'lodash';

console.log("hey");

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist(): Promise<Auth.OAuth2Client|null>{
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials) as Auth.OAuth2Client;
  } catch (err) {
    return null;
  }
}

/**
 * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client: Auth.OAuth2Client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client === null) {
    throw "Why is it null? Fix your stupid credentials"
  }
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

async function getCalendarListEntry(auth: Auth.OAuth2Client) {
  const service = google.calendar({version: 'v3', auth});
  const calendarList = await service.calendarList.list();

  const calendars = calendarList.data.items;
  if (calendars !== null) {
    for (const calendar of calendars!) {
      if (calendar.summary == "Pam Work Import Zone") {
          return calendar;
      }
    }
  }
  throw "Why did nothing return? Fix your stupid config";
};

async function existingEvents(auth: Auth.OAuth2Client, calendarListEntry: calendar_v3.Schema$CalendarListEntry): Promise<calendar_v3.Schema$Events> {
  const calendar = google.calendar({version: 'v3', auth});
  const list = await calendar.events.list({
    auth: auth,
    calendarId: calendarListEntry.id!
  });
  return list.data;
}

async function existingShifts(auth: Auth.OAuth2Client, calendarListEntry: calendar_v3.Schema$CalendarListEntry): Promise<Array<Shift>> {
  const events = await existingEvents(auth, calendarListEntry);
  return events.items!.map(( event ) => {return {
    start: new Date(event.start!.dateTime!),
    end: new Date(event.start!.dateTime!),
  }}
);
}

function insertEvent(auth: Auth.OAuth2Client, calendarListEntry: calendar_v3.Schema$CalendarListEntry, eventJson: calendar_v3.Schema$Event) {
  const calendar = google.calendar({version: 'v3', auth});
  calendar.events.insert({
    auth: auth,
    calendarId: calendarListEntry.id!,
    requestBody: eventJson
  }, function(err, event) {
    if (err) {
      console.log('There was an error contacting the Calendar service: ' + err);
      return;
    }
    console.log('Event created: %s', event!.data.htmlLink);
  });
  
}

async function loadHTML(path: string): Promise<JSDOM> {
  return await JSDOM.fromFile(path);
}

interface Shift {
  start: Date
  end: Date
}

function* shiftsFromHtml(dom: JSDOM): Generator<Shift> {
  const shifts = dom.window.document.querySelectorAll("a.calendar-event-transfershift"); // Yes, each row is a table. why would you do it like that lol
  for (const shift of shifts) {
    const date = shift.getAttribute('data-date');
    if (date === null || shift === null) {
      throw "WHY ISN'T IT IN THERE";
    };
    const hoursMatch = shift.textContent!.match(/\d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m/);
    if (hoursMatch === null) {
      console.warn(`Match expected, but not found, in ${shift.textContent}`)
    };
    const [start, end] = hoursMatch![0].split(" - ");
    yield {
      start: new Date(`${date} ${start}`),
      end: new Date(`${date} ${end}`)
    };
  }
};

async function addShifts(auth: Auth.OAuth2Client, fromHtml: string) {
  const dom = await loadHTML(fromHtml);
  const calendarListEntry = await getCalendarListEntry(auth);
  const eShifts = await existingShifts(auth, calendarListEntry);
  
  for(const newShift of shiftsFromHtml(dom)) {
    if (eShifts.filter(e => e.start.toDateString() === newShift.start.toDateString()).length === 0) {
      insertEvent(auth, calendarListEntry, shiftToEvent(newShift));
      await sleep(1000);
    }
  };
};

function shiftToEvent(shift: Shift): calendar_v3.Schema$Event {
  const startDate = new Date(shift.start);
  const endDate = new Date(shift.end);
  console.log(`${startDate.getHours()%12}:${startDate.getMinutes()}-${endDate.getHours()%12}:${endDate.getMinutes()} Shift`);
  return {
    summary: `${startDate.getHours()%12}:${startDate.getMinutes()}-${endDate.getHours()%12}:${endDate.getMinutes()} Shift`.replace(":00", "").replace(":0", ""),
    start: {
      dateTime: shift.start.toISOString()
    },
    end: {
      dateTime: shift.end.toISOString()
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

authorize().then(async auth => {
  console.log("I'm in.");
  addShifts(auth, 'months\\latest.html');
  
}).catch(error => {
  console.log("fuck");
  console.error(error)
});
