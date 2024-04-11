# beakon
> A decentralized WebRTC signaling service

## Features
- Partial mesh
- Self healing
- Gossip protocol
- Direct messaging

## Todo features
- Message encyryption
- Topic subscriptions
- Video/Audio



<!-- ### Firebase Preparation
1. Install the firebase cli sdk
2. Create a firebase project with a realtime database
3. Create a file named `auth.js` inside the `web/public` folder and save your firebase information to that file
```js
export default {
  apiKey: "<firebase-api-key>",
  authDomain: "<firebase-api-auth-domain>",
  databaseURL: "<firebase-database-url>",
  projectId: "<firebase-project-id>",
  storageBucket: "<firebase-storage-bucket>",
  messagingSenderId: "<firebase-sender-id>",
  appId: "<firebase-app-id>",
  measurementId: "<firebase-measurement-id>",
};
```
5. Adjust your firebase database rules as appropriate:
```json
{
  "rules": {
    "clients": {
      ".read": true,
      ".write": true
    },
    "notifications": {
      ".read": true,
      ".write": true
    },
    ".read": true,
  	".write": true
  }
}
``` -->

## Local Development


## Install
### Node
```
npm install beakon
```
#### Example
```js
import Beakon from "./index.js";
import auth from "./pubnub/auth.js";

import wrtc from "wrtc";

const opts = {
  pubnubConfig: auth,
  simplePeerOpts: { wrtc: wrtc },
  minPeers: 2,
  softCap: 6,
  maxPeers: 9,
  minFanout: 0.33,
  maxFanout: 0.66,
  maxHistory: 10,
  debug: false,
};

const beakon = new Beakon(opts);

beakon.on("peer", (peer) => {
  console.debug("Peer event:", peer.id, peer.state);
  // peer.connection do something with Beakon peer
});

beakon.on("data", (data) => {
  console.log(data.senderId, data.content);
});

process.stdin.on("data", (data) => {
  beakon.send(data.toString().trim());
});
```

### Browser (CDN coming soon)
```html
<script type="module" src=""></script>
```

#### Example
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Beakon - WebRTC Signaling</title>
<script type="module">
  // import Beakon from "../index.js" // project root
  // import Beakon from "./index.js" // this folder
  import Beakon from "https://cdn.jsdelivr.net/npm/beakon/index.js" // cdn
  import auth from "./auth.js"
  
  const opts = {
    pubnubConfig: auth,
    simplePeerOpts: {},
    minPeers: 2,
    softCap: 6,
    maxPeers: 9,
    minFanout: 0.33,
    maxFanout: 0.66,
    maxHistory: 10,
    debug: true,
  }
  
  if (document.readyState === "complete" || document.readyState === "interactive") {
    const beakon = new Beakon(opts);
    
    function sendMessage() {
      console.log("Sending...")
      const inputField = document.getElementById('messageInput');
      const message = inputField.value || Math.floor(Math.random() * 1000).toString();
      beakon.send(message);
      inputField.value = '';
    }

    document.getElementById('sendButton').addEventListener('click', sendMessage);
    
    document.getElementById('messageInput').addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        sendMessage();
      }
    });

    beakon.on('peer', peer => {
      console.log(peer)
      console.debug("Peer event:", peer.id, peer.state)
      // peer.connection do something with Beakon peers
    })

    beakon.on('data', (data) => {
      displayMessage(data.senderId, data.content, data.date);
    });

    function displayMessage(senderId, message, timestamp) {
      const messageContainer = document.getElementById('messages');
      
      const date = new Date(timestamp);
      const formattedDate = date.getTime();
      
      const senderName = (senderId === beakon.peerId) ? 'You' : senderId;
      
      const messageElement = document.createElement('div');
      messageElement.classList.add('message');
      messageElement.innerHTML = `<b>${senderName}</b> at ${formattedDate}: ${message}`;
      
      // Check if the message container has any child elements
      if (messageContainer.firstChild) {
        // If there's at least one message, insert the new message at the top
        messageContainer.insertBefore(messageElement, messageContainer.firstChild);
      } else {
        // If there are no messages, just append the new message
        messageContainer.appendChild(messageElement);
      }
    }
  };
</script>
</head>
<body>
<h2>Beakon - WebRTC Signaling</h2>
<div id="messages"></div>
<div id="sendSection">
  <input type="text" id="messageInput" placeholder="Enter message or send a random number"/>
  <button id="sendButton">Send</button>
</div>
</body>
<style>
  #messages {
    background-color: #f0f0f0;
    padding: 10px;
    margin-top: 20px;
    height: 300px;
    overflow-y: scroll;
    border: 1px solid #ccc;
  }
  .message {
    margin-bottom: 10px;
  }
  #sendSection {
    margin-top: 20px;
  }
</style>
</html>
```

### Usage
#### Initialization
##### `const beakon = new Beakon(opts [[object]])`
Initialize Beakon with the passed in options.

###### `opts` [[object]]
```js
const opts = {
  pubnubConfig: {
    publishKey: "",
    subscribeKey: "",
    userId: "",
  },
  simplePeerOpts: { wrtc: wrtc },
  minPeers: 2,
  softCap: 6,
  maxPeers: 9,
  minFanout: 0.33,
  maxFanout: 0.66,
  maxHistory: 10,
  debug: false,
};
```

#### Methods
##### `send(data [[any]], address [[string]])`
Send a broadcast message to all peers in the partial mesh network

##### `beakon.connections()`
Return the peers in this peer's partial mesh

##### `beakon.on("peer", peer [[object]])`
Listens for new peer events

The `peer` object has the following properties:
```js
peer = {
  id: "", // "peer id"
  state: "", // "connected", "disconnected"
  peer: {}, // the peer instance object
}
```

##### `beakon.on(event [[any]], data [[any]])`
Listen for custom events

##### `beakon.on(event [[any]], data [[any]])`
Listen once for custom events

##### `becon.emit(event [[any]], data [[any]])`
Emit custom events

##### `becon.off(event [[any]], data [[any]])`
Remove custom events

#### Events (default)
##### `connect`
Listen for peer connection events

##### `disconnect`
Listen for peer disconnection events

##### `data`
Listen for data

##### `DEBUG`
Listen for debug events

#### Properties
##### `beakon.seen`
Return the all seen peers in the network
> Seen peers are discovered through heartbeats they gossip through the partial mesh

##### `beakon.messages`
Return the message history a peer knows about