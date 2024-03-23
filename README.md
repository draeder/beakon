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


<!-- ## Install
### Node (coming soon)
```
npm install beakon
```

### Browser (coming soon)
```html
<script type="module" src=""></script>
``` -->

### Usage
#### Initialization
##### `const beakon = new Beakon(opts [[object]])`
Initialize Beakon with the passed in options.

###### `opts` [[object]]
```js
{
  peerId: '', // any unique string
  minPeers: 3, // minimum number of peers
  maxPeers: 9, // maximum number of peers
  discoveryInterval: 5, // (seconds) interval to attempt discovery again if peer count is less than minPeers
  gossipRTT: 150, // retransmit time for gossip
  gossipRT: 3, // retransmit attempts
  fanoutRatio: 0.5, // fanout ratio for gossip through partial mesh
  history: () =>{
    // custom function to manage message history object
  },
  debug: true, // enable/disable debug logging
}
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

##### `message`
Listen for messages

##### `DEBUG`
Listen for debug events

#### Properties
##### `beakon.seen`
Return the all seen peers in the network
> Seen peers are discovered through heartbeats they gossip through the partial mesh

##### `beakon.messages`
Return the message history a peer knows about