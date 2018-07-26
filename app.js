/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  request = require('request'),
  mongoClient = require('mongodb').MongoClient,
  googleMapsClient = require('@google/maps').createClient({
    Promise: Promise,
    key: config.get('googleAPIKey')
  }),
  imageAPI = require('google-maps-image-api-url'),
  fullPostalRegex = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  partialPostalRegex = /^[A-Za-z]\d[A-Za-z][ -]?$/,
  zipCodeRegex = /^\d{5}(?:[-\s]\d{4})?$/,
  messengerCodeImageURL = `https://scontent.xx.fbcdn.net/v/t39.8917-6/37805960_2140756132665343_186347309439647744_n.png?_nc_cat=0&oh=3025e86baa59b89ea70c4bec5f03f51d&oe=5BCD976D`;

var db;
var app = express();
app.set('port', 5000);
app.use(bodyParser.json({
  verify: verifyRequestSignature
}));



/*
 * Open config/default.json and set your config values before running this server.
 * 
 */

// App Dashboard > Dashboard > click the Show button in the App Secret field
const APP_SECRET = config.get('appSecret');

// App Dashboard > Webhooks > Edit Subscription > copy whatever random value you decide to use in the Verify Token field
const VALIDATION_TOKEN = config.get('validationToken');

// App Dashboard > Messenger > Settings > Token Generation > select your page > copy the token that appears
const PAGE_ACCESS_TOKEN = config.get('pageAccessToken');

//connection URL to MongoDB on mLab
const MONGO_DB_URL = config.get('mongoURL');

//how many closest clubs to return
const CLUBS_NUM = config.get('closestClubsToReturn') || 5;

const GOOGLE_API_KEY = config.get('googleAPIKey');

// make sure that everything has been properly configured
if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && MONGO_DB_URL && CLUBS_NUM && GOOGLE_API_KEY)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Verify that the request came from Facebook. You should expect a hash of 
 * the App Secret from your App Dashboard to be present in the x-hub-signature 
 * header field.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // In DEV, log an error. In PROD, throw an error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
      .update(buf)
      .digest('hex');

    console.log("received  %s", signatureHash);
    console.log("exepected %s", expectedHash);
    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}


/*
 * Verify that your validation token matches the one that is sent 
 * from the App Dashboard during the webhook verification check.
 * Only then should you respond to the request with the 
 * challenge that was sent. 
 */
app.get('/webhook', function (req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("[app.get] Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Validation token mismatch.");
    res.sendStatus(403);
  }
});


/*
 * All callbacks from Messenger are POST-ed. All events from all subscription 
 * types are sent to the same webhook. 
 * 
 * Subscribe your app to your page to receive callbacks for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 */
app.post('/webhook', function (req, res) {
  console.log("message received!");
  var data = req.body;
  console.log(JSON.stringify(data));

  if (data.object == 'page') {
    // send back a 200 within 20 seconds to avoid timeouts
    res.sendStatus(200);
    // entries from multiple pages may be batched in one request
    data.entry.forEach(function (pageEntry) {

      // iterate over each messaging event for this page
      pageEntry.messaging.forEach(function (messagingEvent) {
        let propertyNames = Object.keys(messagingEvent);
        console.log("[app.post] Webhook event props: ", propertyNames.join());

        acknowledgeUserMessage(messagingEvent.sender.id);

        if (messagingEvent.message) {
          processMessageFromPage(messagingEvent);
        } else if (messagingEvent.postback) {
          // user replied by tapping a postback button
          processPostbackMessage(messagingEvent);
        } else {
          console.log("[app.post] not prepared to handle this message type.");
        }
        sendSenderAction(messagingEvent.sender.id, "typing_off");
      });
    });


  }
});

/*
 * called when a postback button is tapped 
 * ie. buttons in structured messages and the Get Started button 
 *
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function processPostbackMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // the developer-defined field you set when you create postback buttons
  var payload = event.postback.payload;

  console.log("[processPostbackMessage] from user (%d) " +
    "on page (%d) " +
    "with payload ('%s') " +
    "at (%d)",
    senderID, recipientID, payload, timeOfPostback);
  if (payload === 'Get Started') {
    sendHelpOptionsAsQuickReplies(senderID);
  }
  else if (payload.indexOf('clubId:') > -1) {
    const clubName = payload.split(':')[1];
    sendMoreDetailsTemplate(senderID, clubName);
  }
}

async function getClub(clubName) {
  const club = await db.collection('clubs').findOne({ clubName: { $eq: clubName } });
  return club;
}

async function sendMoreDetailsTemplate(recipientId, clubName) {

  const club = await getClub(clubName);
  console.log(JSON.stringify(club));
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              "title":"Welcome!",
              "image_url":"https://petersfancybrownhats.com/company_image.png",
              "subtitle":"We have the right hat for everyone.",
              "default_action": {
                "type": "web_url",
                "url": "https://petersfancybrownhats.com/view?item=103",
                "webview_height_ratio": "tall",
              },
              "buttons":[
                {
                  "type":"web_url",
                  "url":"https://petersfancybrownhats.com",
                  "title":"View Website"
                },{
                  "type":"postback",
                  "title":"Start Chatting",
                  "payload":"DEVELOPER_DEFINED_PAYLOAD"
                }              
              ]      
            }
          ]
        }
      }
    }
  };
}

async function respondWithClosestClubs(senderID, messageText, regionCode, coordinates) {
  try {
    const clubs = await getClosestClubs(messageText, coordinates, regionCode);
    sendTextMessage(senderID, `Here are the ${CLUBS_NUM} closest clubs: \n`);
    sendGenericTemplates(senderID, clubs);
  } catch (err) {
    console.log(err);
    sendTextMessage(senderID, err);
  }
}

/*
 * Called when a message is sent to your page. 
 * 
 */
function processMessageFromPage(event) {
  var senderID = event.sender.id;
  var pageID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("[processMessageFromPage] user (%d) page (%d) timestamp (%d) and message (%s)",
    senderID, pageID, timeOfMessage, JSON.stringify(message));

  if (message.quick_reply) {
    // user tapped one of the two quick reply buttons: Postal Code or Send Location
    console.log("[processMessageFromPage] quick_reply.payload (%s)",
      message.quick_reply.payload);
    handleQuickReplyResponse(event);
    return;
  }

  // the 'message' object format can vary depending on the kind of message that was received.
  // See: https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
  var messageText = message.text;
  if (messageText) {
    console.log("[processMessageFromPage]: %s", messageText);
    var lowerCaseMsg = messageText.toLowerCase();
    if (lowerCaseMsg === 'help') {
      // handle 'help' as a special case
      sendHelpOptionsAsQuickReplies(senderID);

    } else if (messageText.match(partialPostalRegex) || messageText.match(fullPostalRegex)) {

      // handle postal code
      respondWithClosestClubs(senderID, messageText, 'ca', null);

    } else if (messageText.match(zipCodeRegex)) {

      //us zip code so restrict and search for provided location in US
      respondWithClosestClubs(senderID, messageText, 'us', null);

    } else {
      // the user sent a message we're not prepared to handle
      var msg = 'I\'m only capable of responding to one plain text word and that word is \'help\'';
      sendTextMessage(senderID, msg);
    }

  }

  if (message.attachments && message.attachments.length > 0) {
    //got attachments
    const att = message.attachments[0];
    if (att && att.type === 'location') {
      //got location attachment
      const coordinates = att.payload.coordinates;
      respondWithClosestClubs(senderID, null, null, coordinates);
    }
  }
}

/*
 * Send a message with the two Quick Reply buttons for Postal Code and Location
 * 
 */
function sendHelpOptionsAsQuickReplies(recipientId) {
  console.log("[sendHelpOptionsAsQuickReplies] Sending help options menu");
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "To find a club near you, provide your current location or a Postal Code.",
      quick_replies: [{
          "content_type": "text",
          "title": "Postal Code",
          "payload": "QR_POSTAL_CODE"
        },
        {
          "content_type": "text",
          "title": "Current Location",
          "payload": "QR_LOCATION"
        }
      ]
    }
  };
  callSendAPI(messageData);
}

/*
 * user tapped a Quick Reply button; respond with the appropriate followup request
 * 
 */
function handleQuickReplyResponse(event) {
  var senderID = event.sender.id;
  var pageID = event.recipient.id;
  var message = event.message;
  var quickReplyPayload = message.quick_reply.payload;

  console.log("[handleQuickReplyResponse] Handling quick reply response (%s) from sender (%d) to page (%d) with message (%s)",
    quickReplyPayload, senderID, pageID, JSON.stringify(message));

  switch (quickReplyPayload) {
    case 'QR_POSTAL_CODE':
      requestUsersPostalCode(senderID);
      break;
    case 'QR_LOCATION':
      requestUsersLocation(senderID);
      break;
  }
}

function requestUsersPostalCode(senderID) {
  // create the message you'll send to ask the user to enter their postal code.
  var messageData = {
    recipient: {
      id: senderID
    },
    message: {
      "text": "Please enter your Postal Code."
    }
  };
  callSendAPI(messageData);
}

function requestUsersLocation(senderID) {
  // create the message you'll send to ask the user to enter their postal code.
  var messageData = {
    recipient: {
      id: senderID
    },
    message: {
      text: "Please tap the button to send your current location.",
      quick_replies: [{
        content_type: "location"
      }]
    }
  };
  callSendAPI(messageData);
}

function compileAddressString(addressObj) {
  return `${addressObj.streetNumber} ${addressObj.streetName}, 
  ${addressObj.city}, ${addressObj.province} ${addressObj.postal}`;
}

function getMultipleGenericTemplates(recipientId, clubObjects) {

  var messages = [];

  for (const clubObject of clubObjects) {
    var btns = [];
    var defaultAction = null;

    if (clubObject.website) {
      btns.push({
        type: "web_url",
        url: clubObject.website,
        title: "View Website"
      });
      defaultAction = {
        type: "web_url",
        url: clubObject.website,
        webview_height_ratio: "tall"
      };
    }
    // if (clubObject.membershipContact.phone) {
    //   btns.push({
    //     type: "phone_number",
    //     title: `Call for membership`, // was too long to include name ${clubObject.membershipContact.name}
    //     payload: clubObject.membershipContact.phone
    //   });
    // }

    //more info button
    btns.push({
      "type": "postback",
      "title": "More Info",
      "payload": `clubId:${clubObject.clubName}`
    });

    //share button
    // btns.push({
    //   type: "element_share",
    //   share_contents: {
    //     attachment: {
    //       "type": "template",
    //       "payload": {
    //         "template_type": "generic",
    //         "elements": [
    //           {
    //             "title": clubObject.clubName,
    //             "subtitle": compileAddressString(clubObject.meetings.address),
    //             "image_url": clubObject.imageUrl,
    //             "default_action": defaultAction,
    //             "buttons": [
    //               // {
    //               //   "type": "web_url",
    //               //   "url": clubObject.website || 'https://directory.lionsclubs.org/', 
    //               //   "title": "Find your local Lions Club"
    //               // }
    //             ]
    //           }
    //         ]
    //       }
    //     }
    //   }
    // });

    var messageData = {
      title: clubObject.clubName,
      image_url: clubObject.imageUrl,
      subtitle: compileAddressString(clubObject.meetings.address),
      buttons: btns
    }
    if (defaultAction) {
      messageData.default_action = defaultAction;
    }
    messages.push(messageData);
  }
  return messages;
}

/**
 * Send multiple generic templates using the Send API
 */
function sendGenericTemplates(recipientId, clubs) {
  var templates = getMultipleGenericTemplates(recipientId, clubs);
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: templates
        }
      }
    }
  };
  console.log("[sendMultipleGenericTemplates] %s", JSON.stringify(messageData));
  callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText // utf-8, 640-character max
    }
  };
  console.log("[sendTextMessage] %s", JSON.stringify(messageData));
  callSendAPI(messageData);
}


/** As a best practice to send an acknowledgement 
 * to user for their message
 */
function acknowledgeUserMessage(recipientId) {
  //to show that user's message was seen
  sendSenderAction(recipientId, "mark_seen");
  //to show that the message is being responded to
  sendSenderAction(recipientId, "typing_on");
}

function sendSenderAction(recipientId, senderAction) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: senderAction
  };
  console.log("[sendSenderAction] %s", JSON.stringify(messageData));
  callSendAPI(messageData);
}

/*
 * Call the Send API. If the call succeeds, the 
 * message id is returned in the response.
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: {
      access_token: PAGE_ACCESS_TOKEN
    },
    method: 'POST',
    json: messageData
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("[callSendAPI] message id %s sent to recipient %s",
          messageId, recipientId);
      } else {
        console.log("[callSendAPI] called Send API for recipient %s",
          recipientId);
      }
    } else {
      console.error("[callSendAPI] Send API call failed", response.statusCode, response.statusMessage, body.error);
    }
  });
}


/**
 *  Connect to the database
 */
mongoClient.connect(MONGO_DB_URL, {
  useNewUrlParser: true
}, (err, client) => {
  if (err) return console.log(err);
  db = client.db('lions-clubs-addresses');
  /*
   * Start your server
   */
  app.listen(app.get('port'), function () {
    console.log('[app.listen] Node app is running on port', app.get('port'));
  });
});

function callGeocode(paramObj) {
  return googleMapsClient.geocode(paramObj).asPromise();
}

// function parseAddressToString(addressObj) {
//   return `${addressObj.streetNumber} ${addressObj.streetName}, ${addressObj.city}, ${addressObj.province}`;
// }

//parse longitude and latitude
function getGeocodeLocation(data) {
  if (data.geometry) {
    return data.geometry.location;
  } else {
    return '';
  }
}

function callDistanceMatrix(query) {
  return googleMapsClient.distanceMatrix(query).asPromise();
}

// function getClubInfo(obj) {
//   const result = `${obj.clubName}
//   ${obj.meetings.address.streetNumber} ${obj.meetings.address.streetName}, 
//   ${obj.meetings.address.city}, ${obj.meetings.address.province}, 
//   ${obj.meetings.address.postal}\n`;
//   return result;
// }

/**
 * make a call to Maps Static API and returns a PNG image url
 * with client's location as blue pinpoint and a club's - as red
 * @param {client's location string as 'lon,lat'} clientLocationString 
 * @param {club's location string as 'lon,lat'} clubLocationString 
 */
function getMapImageUrl(clientLocationString, clubLocationString) {
  return imageAPI({
    center: '',
    key: GOOGLE_API_KEY,
    type: 'staticmap',
    size: '573x300', //'500x260',
    maptype: 'roadmap',
    format: 'PNG',
    markers: [`size:mid|color:blue|${clientLocationString}`, `size:mid|color:red|${clubLocationString}`],
  });
}

async function getCoordinates(addr, regionCode) {
  const addressObj = {
    address: addr,
    region: regionCode || 'ca'
  };
  const response = await callGeocode(addressObj);
  if (response.status !== 200) {
    console.log(response.error_message);
    return '';
  } else {
    if (response.json.results.length > 0) {
      const geoData = response.json.results[0];
      const originLonLat = getGeocodeLocation(geoData);
      return originLonLat.lat + ',' + originLonLat.lng;
    } else {
      return '';
    }
  }
}

/** 
 * By providing an address (if postal code it would be approximate location) it 
 * will return an array of clubs which are closest to provided address
 * if providing coordinates, it will be used straigh without checking Google API Geocode
 * regionCode, if provided, restricts geocoding to that region
 */
async function getClosestClubs(address, coordinates, regionCode) {
  return new Promise(async (resolve, reject) => {

    try {
      //first check if coordinates already passed so no need to lookup
      //get origin formatted "latitude,longitude"
      let origin = '';
      if (coordinates) {
        origin = `${coordinates.lat},${coordinates.long}`;
      } else {
        origin = await getCoordinates(address, regionCode);
      }
      if (origin === '') {
        reject('Could not determine your location, please make sure the postal code is correct or full');
      } else {
        const clubs = await db.collection('clubs').find().toArray();
        const locations = clubs.map(item =>
          item.meetings.address.location.lat + ',' + item.meetings.address.location.lng
        );

        const query = {
          origins: [origin],
          destinations: locations
        };

        const distResponse = await callDistanceMatrix(query);

        if (distResponse.status !== 200) {
          console.log(distResponse.error_message);
          reject("There was a problem determining distance from you to closest clubs");
        } else {
          const result = distResponse.json;
          if (result.status !== 'OK') {
            console.log(result.error_message);
            reject("Something went wrong, please give it a try in a minute");
          } else {

            const returnedElements = result.rows[0].elements;
            const distancesToSort = returnedElements.map((el, index) => [el.distance.value, index]);
            distancesToSort.sort((a, b) => a[0] - b[0]);
            const requiredIndexedDistances = distancesToSort.slice(0, CLUBS_NUM);
            let foundClubs = [];
            for (let i = 0; i < requiredIndexedDistances.length; i++) {
              const c = clubs[requiredIndexedDistances[i][1]];
              let img = '';
              try {
                img = await getMapImageUrl(origin, `${c.meetings.address.location.lat},${c.meetings.address.location.lng}`);
                console.log(img);
              } catch (err) {
                console.log(err);
              }
              c.imageUrl = img;
              foundClubs.push(c);
            }
            //const foundClubs = clubs.filter((el, index) => r.map(e => e[1] === index)).forEach(element => getClubInfo(element));
            resolve(foundClubs);
          }
        }
      }
    } catch (err) {
      console.log(err);
      reject("Something went terribly wrong. Apologies");
    }
  });
}



module.exports = app;